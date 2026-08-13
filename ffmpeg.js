'use strict';

// Locating and, if necessary, installing ffmpeg.
//
// Resolution order:
//   1. a copy we previously downloaded into converter-app/bin
//   2. ffmpeg on PATH
//   3. nothing -- the UI offers to install
//
// Installing prefers unpacking a static build into converter-app/bin, and only
// falls back to winget. That order is deliberate: the local unpack touches
// nothing outside the app folder and never needs administrator rights, so it
// works on a locked-down machine where winget would stall on an elevation
// prompt nobody is watching.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

// In a packaged build __dirname points inside the executable, which is not a
// real directory, so the downloaded binaries have to land next to the app. On
// macOS that means beside the .app bundle, not inside Contents/MacOS -- see
// resolveRoot() in server.js, which places input/ and output/ the same way.
function appFolder() {
  try {
    if (require('node:sea').isSea()) {
      const exeDir = path.dirname(process.execPath);
      const bundle = exeDir.match(/^(.*\.app)[/\\]Contents[/\\]MacOS$/);
      return bundle ? path.dirname(bundle[1]) : exeDir;
    }
  } catch { /* not a SEA build */ }
  return __dirname;
}

const BIN_DIR = path.join(appFolder(), 'bin');
const EXE = process.platform === 'win32' ? '.exe' : '';

// Static builds per platform; each entry is one archive holding both binaries,
// or a pair of archives. Mirrors are tried in order.
//
// macOS lists the other architecture as a fallback: an x86_64 build still runs
// on Apple Silicon through Rosetta 2, so a missing native build is not fatal.
const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';

const DOWNLOAD_SOURCES = {
  win32: {
    x64: [
      { single: `${BTBN}/ffmpeg-n7.1-latest-win64-gpl-7.1.zip` },
      { single: `${BTBN}/ffmpeg-master-latest-win64-gpl.zip` },
    ],
  },
  darwin: {
    arm64: [
      {
        ffmpeg: 'https://www.osxexperts.net/ffmpeg711arm.zip',
        ffprobe: 'https://www.osxexperts.net/ffprobe711arm.zip',
      },
      {
        ffmpeg: 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip',
        ffprobe: 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip',
      },
    ],
    x64: [
      {
        ffmpeg: 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip',
        ffprobe: 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip',
      },
    ],
  },
};

function downloadSources() {
  const perPlatform = DOWNLOAD_SOURCES[process.platform];
  if (!perPlatform) return [];
  return perPlatform[process.arch] || [];
}

// If no data arrives for this long, treat the mirror as dead and move on rather
// than leaving the user staring at a stalled progress line.
const STALL_TIMEOUT_MS = 30000;

function runsOk(exe, args) {
  try {
    const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

function versionOf(exe) {
  try {
    const r = spawnSync(exe, ['-version'], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return null;
    const m = /^ffmpeg version (\S+)/m.exec(r.stdout || '');
    return m ? m[1] : 'unknown';
  } catch {
    return null;
  }
}

// Both binaries are needed: ffmpeg encodes, ffprobe reads durations for the
// progress bar and the final sanity check.
function pairAt(dir) {
  const ffmpeg = path.join(dir, `ffmpeg${EXE}`);
  const ffprobe = path.join(dir, `ffprobe${EXE}`);
  if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) return null;
  if (!runsOk(ffmpeg, ['-version']) || !runsOk(ffprobe, ['-version'])) return null;
  return { ffmpeg, ffprobe, source: 'bundled', version: versionOf(ffmpeg) };
}

function pairOnPath() {
  if (!runsOk(`ffmpeg${EXE}`, ['-version'])) return null;
  if (!runsOk(`ffprobe${EXE}`, ['-version'])) return null;
  return {
    ffmpeg: `ffmpeg${EXE}`,
    ffprobe: `ffprobe${EXE}`,
    source: 'path',
    version: versionOf(`ffmpeg${EXE}`),
  };
}

/** @returns {{ffmpeg:string,ffprobe:string,source:string,version:string}|null} */
function locate() {
  return pairAt(BIN_DIR) || pairOnPath();
}

function hasWinget() {
  return process.platform === 'win32' && runsOk('winget', ['--version']);
}

// Install methods report progress as plain lines so the UI can stream them.
function installViaWinget(onLine) {
  return new Promise((resolve) => {
    onLine('Installing ffmpeg via winget...');
    onLine('If Windows shows a permission prompt, please accept it.');
    const child = spawn(
      'winget',
      [
        'install',
        '--id', 'BtbN.FFmpeg.GPL.7.1',
        '-e',
        '--source', 'winget',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity',
      ],
      { windowsHide: true }
    );

    const relay = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        // winget paints progress with box-drawing characters and backspaces;
        // those turn into noise in a browser log, so keep only real messages.
        const clean = line.replace(/[▀-▟■-◿\b\r]/g, '').trim();
        if (clean) onLine(clean);
      }
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);

    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, error: `winget exited with code ${code}` });
      // winget updates the machine PATH, but this process inherited its
      // environment at launch and will not see the change. Read the fresh PATH
      // out of the registry so the install is usable without a restart.
      refreshPathFromRegistry();
      resolve({ ok: !!locate(), error: 'winget finished but ffmpeg is still not runnable' });
    });
  });
}

function refreshPathFromRegistry() {
  if (process.platform !== 'win32') return;
  const read = (root, key) => {
    const r = spawnSync('reg', ['query', root, '/v', key], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status !== 0) return '';
    const m = /Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(r.stdout || '');
    return m ? m[1].trim() : '';
  };
  const machine = read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path');
  const user = read('HKCU\\Environment', 'Path');
  const merged = [process.env.PATH, machine, user].filter(Boolean).join(path.delimiter);
  // Expand %VAR% references that REG_EXPAND_SZ values carry verbatim.
  process.env.PATH = merged.replace(/%([^%]+)%/g, (whole, name) => process.env[name] || whole);
}

/**
 * Unpack a zip using tools that ship with the operating system.
 *
 * Helpers are addressed by absolute path wherever possible rather than by name.
 * A bare "powershell" or "unzip" only resolves if the usual system directories
 * are on PATH, and on a machine with a trimmed PATH the spawn fails with a bare
 * ENOENT that surfaces as an empty error message.
 *
 * Windows: tar.exe has shipped since build 17063 and handles zip; PowerShell's
 * Expand-Archive covers older builds.
 * macOS: /usr/bin/unzip is present on every install, with ditto as backup.
 *
 * @returns {string|null} an error message, or null on success
 */
function extractZip(zipPath, destDir) {
  const attempts = [];

  if (process.platform === 'win32') {
    const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

    const tarExe = path.join(system32, 'tar.exe');
    if (fs.existsSync(tarExe)) {
      attempts.push({ cmd: tarExe, args: ['-xf', zipPath, '-C', destDir] });
    }

    const psExe = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    attempts.push({
      cmd: fs.existsSync(psExe) ? psExe : 'powershell',
      args: [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ],
    });
  } else {
    // -o overwrites without prompting; without it a repeated install would
    // block forever waiting on stdin that nobody is attached to.
    attempts.push({ cmd: '/usr/bin/unzip', args: ['-o', '-q', zipPath, '-d', destDir] });
    attempts.push({ cmd: '/usr/bin/ditto', args: ['-x', '-k', zipPath, destDir] });
    attempts.push({ cmd: 'unzip', args: ['-o', '-q', zipPath, '-d', destDir] });
  }

  let lastError = 'no extraction tool available';
  for (const attempt of attempts) {
    if (attempt.cmd.startsWith('/') && !fs.existsSync(attempt.cmd)) continue;
    const r = spawnSync(attempt.cmd, attempt.args, {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status === 0) return null;
    lastError =
      (r.error && r.error.message) ||
      (r.stderr || '').trim().split('\n')[0] ||
      `exit code ${r.status}`;
  }
  return lastError;
}

/** Download one URL to disk, aborting if the transfer stalls. */
async function downloadTo(url, destPath, onLine) {
  const controller = new AbortController();
  let stallTimer = null;
  const armStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
  };

  armStallTimer();
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: controller.signal });
  } catch (err) {
    clearTimeout(stallTimer);
    throw new Error(err.name === 'AbortError' ? 'no response' : err.message);
  }
  if (!res.ok) {
    clearTimeout(stallTimer);
    throw new Error(`HTTP ${res.status}`);
  }

  const total = Number(res.headers.get('content-length')) || 0;
  onLine(total ? `Downloading ffmpeg (${Math.round(total / 1048576)} MB)...` : 'Downloading ffmpeg...');

  const out = fs.createWriteStream(destPath);
  let received = 0;
  let lastPct = -1;

  try {
    for await (const chunk of res.body) {
      armStallTimer();
      received += chunk.length;
      if (!out.write(chunk)) {
        await new Promise((resolve) => out.once('drain', resolve));
      }
      if (total) {
        const pct = Math.floor((received / total) * 100);
        // Report every 10% -- enough to look alive without flooding the log.
        if (pct >= lastPct + 10) {
          lastPct = pct;
          onLine(`Downloading... ${pct}%`);
        }
      }
    }
  } catch (err) {
    out.destroy();
    throw new Error(
      controller.signal.aborted ? 'the download stalled' : err.message
    );
  } finally {
    clearTimeout(stallTimer);
  }

  await new Promise((resolve, reject) => {
    out.on('error', reject);
    out.on('finish', resolve);
    out.end();
  });

  // A truncated archive fails confusingly at the extract step, so catch it here
  // where the message can say what actually went wrong.
  if (total && received < total) {
    throw new Error('the download ended early');
  }
}

/** Download and unpack one source entry into a staging folder. */
async function fetchAndExtract(source, tmp, onLine) {
  // A source is either one archive with both binaries, or one archive each.
  const jobs = source.single
    ? [{ url: source.single, label: 'ffmpeg' }]
    : [
        { url: source.ffmpeg, label: 'ffmpeg' },
        { url: source.ffprobe, label: 'ffprobe' },
      ];

  const extractDir = path.join(tmp, 'x');
  await fsp.mkdir(extractDir, { recursive: true });

  for (const job of jobs) {
    const zipPath = path.join(tmp, `${job.label}.zip`);
    await downloadTo(job.url, zipPath, onLine);
    const error = extractZip(zipPath, extractDir);
    if (error) throw new Error(`extract failed: ${error}`);
    await fsp.unlink(zipPath).catch(() => {});
  }

  return extractDir;
}

async function installStaticBuild(onLine) {
  const sources = downloadSources();
  if (!sources.length) {
    return {
      ok: false,
      error:
        `No automatic download is available for ${process.platform}/${process.arch}. ` +
        'Please install ffmpeg manually and restart the app.',
    };
  }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ffmpeg-dl-'));
  try {
    let extractDir = null;
    let lastError = 'no download source worked';

    for (const [index, source] of sources.entries()) {
      try {
        if (index > 0) onLine('Trying another download source...');
        extractDir = await fetchAndExtract(source, tmp, onLine);
        break;
      } catch (err) {
        lastError = err.message;
        onLine(`That source failed (${err.message}).`);
        await fsp.rm(path.join(tmp, 'x'), { recursive: true, force: true }).catch(() => {});
      }
    }
    if (!extractDir) throw new Error(lastError);

    onLine('Extracting...');
    // Windows archives nest the binaries under ffmpeg-<version>/bin; the macOS
    // ones drop them at the top level. Search either way.
    const found = findBinaries(extractDir);
    if (!found) throw new Error('could not find ffmpeg inside the archive');

    await fsp.mkdir(BIN_DIR, { recursive: true });
    for (const key of ['ffmpeg', 'ffprobe']) {
      const dest = path.join(BIN_DIR, `${key}${EXE}`);
      await fsp.copyFile(found[key], dest);
      // Archives unpacked on macOS do not reliably keep the executable bit,
      // and a binary without it fails with a bare EACCES.
      if (process.platform !== 'win32') {
        await fsp.chmod(dest, 0o755).catch(() => {});
      }
    }

    if (process.platform === 'darwin') {
      await clearQuarantine(BIN_DIR, onLine);
    }

    const pair = pairAt(BIN_DIR);
    if (!pair) throw new Error('the downloaded files are not runnable');
    onLine(`Installed ffmpeg ${pair.version}.`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Gatekeeper tags anything downloaded with com.apple.quarantine, and running a
 * quarantined unsigned binary is blocked with a dialog the app cannot dismiss.
 * Stripping the attribute on files we just downloaded ourselves is what every
 * ffmpeg installer for macOS does; without it the very first convert fails.
 */
async function clearQuarantine(dir, onLine) {
  const xattr = '/usr/bin/xattr';
  if (!fs.existsSync(xattr)) return;
  const r = spawnSync(xattr, ['-dr', 'com.apple.quarantine', dir], {
    encoding: 'utf8',
  });
  if (r.status !== 0 && onLine) {
    onLine('Note: could not clear the macOS quarantine flag.');
  }
}

/** Locate ffmpeg and ffprobe anywhere inside an extracted archive. */
function findBinaries(root) {
  const wanted = { ffmpeg: `ffmpeg${EXE}`, ffprobe: `ffprobe${EXE}` };
  const found = {};
  const stack = [root];

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // __MACOSX holds resource-fork stubs that share the real file names
        // and would otherwise be picked up instead of the actual binaries.
        if (entry.name !== '__MACOSX') stack.push(full);
      } else {
        for (const [key, name] of Object.entries(wanted)) {
          if (!found[key] && entry.name === name) found[key] = full;
        }
      }
    }
    if (found.ffmpeg && found.ffprobe) return found;
  }
  return null;
}

/**
 * Homebrew is the macOS counterpart to winget: a fallback for the case where
 * the direct download is blocked, and only useful if the user already has it.
 * Both possible prefixes are checked because Apple Silicon installs to
 * /opt/homebrew while Intel uses /usr/local.
 */
function brewPath() {
  if (process.platform !== 'darwin') return null;
  for (const candidate of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function installViaBrew(brew, onLine) {
  return new Promise((resolve) => {
    onLine('Installing ffmpeg via Homebrew. This can take several minutes...');
    const child = spawn(brew, ['install', 'ffmpeg']);

    const relay = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        const clean = line.replace(/[\r\b]/g, '').trim();
        if (clean) onLine(clean);
      }
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);

    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, error: `brew exited with code ${code}` });
      // Homebrew's bin directory is not necessarily on this process's PATH.
      const prefix = path.dirname(brew);
      if (!process.env.PATH.split(path.delimiter).includes(prefix)) {
        process.env.PATH = `${prefix}${path.delimiter}${process.env.PATH}`;
      }
      resolve({ ok: !!locate(), error: 'brew finished but ffmpeg is still not runnable' });
    });
  });
}

/**
 * Install ffmpeg into the app folder, falling back to the system package
 * manager if the direct download fails.
 * @param {(line:string)=>void} onLine progress sink
 */
async function install(onLine) {
  if (locate()) return { ok: true };

  const viaDownload = await installStaticBuild(onLine);
  if (viaDownload.ok) return viaDownload;

  if (hasWinget()) {
    onLine(`Direct download did not work (${viaDownload.error}). Trying winget instead.`);
    const viaWinget = await installViaWinget(onLine);
    if (viaWinget.ok) return viaWinget;
    return { ok: false, error: viaWinget.error };
  }

  const brew = brewPath();
  if (brew) {
    onLine(`Direct download did not work (${viaDownload.error}). Trying Homebrew instead.`);
    const viaBrew = await installViaBrew(brew, onLine);
    if (viaBrew.ok) return viaBrew;
    return { ok: false, error: viaBrew.error };
  }

  return { ok: false, error: viaDownload.error };
}

/** Whether this platform/architecture has an automatic install path. */
function canInstall() {
  return downloadSources().length > 0 || !!brewPath() || hasWinget();
}

module.exports = { locate, install, canInstall, BIN_DIR };
