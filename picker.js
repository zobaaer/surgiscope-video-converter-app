'use strict';

// Turning user-supplied locations into a list of convertible files.
//
// No native dialog and no subprocess: an earlier version wrote a .ps1 to temp
// and ran it with -ExecutionPolicy Bypass, which antivirus blocked on sight.
// Selection happens in the browser; this module only resolves what comes back.

const fsp = require('fs/promises');
const path = require('path');

const VIDEO_EXTENSIONS = [
  'mp4', 'mov', 'mkv', 'avi', 'm4v', 'webm', 'mpg', 'mpeg',
  'wmv', 'flv', 'ts', 'm2ts', 'mts', '3gp', 'ogv',
];

const VIDEO_RE = new RegExp(`\\.(${VIDEO_EXTENSIONS.join('|')})$`, 'i');

/** Describe one source file, or explain why it cannot be used. */
async function describeSource(filePath) {
  const entry = { path: filePath, name: path.basename(filePath) };
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      entry.error = 'not a file';
      return entry;
    }
    entry.size = stat.size;
    // Read access is what actually matters, and only opening it proves that.
    const handle = await fsp.open(filePath, 'r');
    await handle.close();
  } catch (err) {
    entry.error =
      err.code === 'ENOENT' ? 'file not found'
      : err.code === 'EACCES' || err.code === 'EPERM' ? 'no permission to read this file'
      : err.message;
  }
  return entry;
}

/**
 * Expand a list of files and folders into convertible video files.
 *
 * @param {string[]} inputs   absolute paths, files or directories
 * @param {boolean} recursive whether to descend into subfolders
 * @param {string[]} [only]   if given, keep only files with these names
 */
async function resolveInputs(inputs, recursive = false, only = null) {
  const wanted = Array.isArray(only) && only.length ? new Set(only) : null;
  const out = [];
  const seen = new Set();

  for (const raw of inputs) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const full = path.resolve(raw.trim());

    let stat;
    try {
      stat = await fsp.stat(full);
    } catch {
      out.push({ path: full, name: path.basename(full), error: 'not found' });
      continue;
    }

    if (stat.isDirectory()) {
      for (const file of await listVideos(full, recursive)) {
        if (wanted && !wanted.has(path.basename(file))) continue;
        if (seen.has(file)) continue;
        seen.add(file);
        out.push(await describeSource(file));
      }
    } else {
      if (seen.has(full)) continue;
      seen.add(full);
      out.push(await describeSource(full));
    }
  }

  return out;
}

/** Collect video files in a folder, optionally descending into subfolders. */
async function listVideos(dir, recursive, depth = 0) {
  // A runaway symlink loop or a pathologically deep tree would otherwise walk
  // forever; nothing legitimate nests videos this far down.
  if (depth > 8) return [];

  const found = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (VIDEO_RE.test(entry.name)) found.push(full);
    } else if (entry.isDirectory() && recursive) {
      found.push(...(await listVideos(full, recursive, depth + 1)));
    }
  }

  found.sort((a, b) => a.localeCompare(b));
  return found;
}

/**
 * Places a user's videos plausibly live, best guesses first. The browser gives
 * a folder's name but never its location, so it has to be searched for.
 */
function searchRoots() {
  const os = require('os');
  const home = os.homedir();
  const roots = [];

  for (const name of ['Videos', 'Movies', 'Desktop', 'Downloads', 'Documents', 'Pictures']) {
    roots.push(path.join(home, name));
  }
  roots.push(home);

  if (process.platform === 'win32') {
    // Fixed drives only: probing every letter would spin up disconnected
    // network drives and stall for seconds each.
    for (const letter of 'CDEFGH') {
      roots.push(`${letter}:\\`);
      roots.push(`${letter}:\\Videos`);
    }
  } else {
    roots.push('/Volumes', '/media', '/mnt');
  }

  return roots;
}

/**
 * Find a folder by name, or files by name, without being told where they are.
 *
 * @param {object} opts
 * @param {string} [opts.folderName] folder to look for
 * @param {string[]} [opts.fileNames] file names to look for
 * @param {string[]} [opts.sample]    relative paths used to confirm a match
 * @param {boolean} [opts.recursive]  descend into subfolders once found
 */
async function locate(opts = {}) {
  const { folderName, fileNames, sample, recursive, only } = opts;

  if (folderName) {
    const match = await findFolder(folderName, sample);
    if (!match) return [];
    return resolveInputs([match], !!recursive, only);
  }

  if (Array.isArray(fileNames) && fileNames.length) {
    const found = await findFiles(fileNames);
    return found.length ? resolveInputs(found, false) : [];
  }

  return [];
}

/** Look for named files in the search roots and one level below them. */
async function findFiles(fileNames) {
  const wanted = new Set(fileNames);
  const found = [];

  const tryDir = async (dir) => {
    for (const name of wanted) {
      const candidate = path.join(dir, name);
      try {
        const stat = await fsp.stat(candidate);
        if (stat.isFile()) {
          found.push(candidate);
          wanted.delete(name);
        }
      } catch { /* not here */ }
    }
  };

  for (const root of searchRoots()) {
    await tryDir(root);
    if (!wanted.size) return found;
  }

  // Two levels below each root. This is the common case -- videos sit in
  // Videos/Project/clip.mp4 far more often than loose in Videos -- and the
  // whole sweep still finishes in milliseconds.
  for (const depth of [1, 2]) {
    for (const dir of await descend(searchRoots(), depth)) {
      await tryDir(dir);
      if (!wanted.size) return found;
    }
  }

  return found;
}

/** Directories exactly `levels` below the given roots. */
async function descend(roots, levels) {
  let current = roots;
  for (let i = 0; i < levels; i++) {
    const next = [];
    for (const dir of current) {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        // Skip the system and application trees: they hold no user videos and
        // walking them costs far more than the rest of the search combined.
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        if (/^(Windows|Program Files|Program Files \(x86\)|ProgramData|\$Recycle\.Bin|System Volume Information|Applications|Library|System)$/i.test(entry.name)) continue;
        next.push(path.join(dir, entry.name));
      }
    }
    current = next;
    if (!current.length) break;
  }
  return current;
}

/** Look for a folder by name, two levels deep under each search root. */
async function findFolder(folderName, sample) {
  const candidates = [];

  for (const root of searchRoots()) {
    candidates.push(path.join(root, folderName));
  }

  for (const candidate of candidates) {
    if (await confirmFolder(candidate, sample)) return candidate;
  }

  // Nothing directly inside a known root; look one level further down, which
  // catches the common "Videos/Projects/Holiday 2024" arrangement.
  for (const root of searchRoots()) {
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, folderName);
      if (await confirmFolder(candidate, sample)) return candidate;
    }
  }

  return null;
}

/**
 * Check a candidate really is the folder the browser showed us. Two folders can
 * share a name, so a sample file must be present before accepting the match.
 */
async function confirmFolder(dir, sample) {
  let stat;
  try {
    stat = await fsp.stat(dir);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;

  if (!Array.isArray(sample) || !sample.length) return true;

  for (const rel of sample) {
    // The sample paths start with the folder's own name; drop that segment.
    const inner = rel.split('/').slice(1).join(path.sep);
    if (!inner) continue;
    try {
      await fsp.access(path.join(dir, inner));
      return true;
    } catch { /* try the next sample */ }
  }
  return false;
}

module.exports = {
  resolveInputs,
  describeSource,
  locate,
  VIDEO_EXTENSIONS,
  VIDEO_RE,
};
