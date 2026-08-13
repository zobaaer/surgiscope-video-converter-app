'use strict';

// Local web server for the converter GUI.
//
// Binds to 127.0.0.1 only -- this is a local tool, not something that should be
// reachable from the network. The port is chosen at runtime so two copies can
// run at once and so a port already in use never blocks startup.
//
// Sources are read from wherever they already live on disk; nothing is copied
// or staged. The browser cannot reveal a real path, so the file list comes from
// a native picker (see picker.js) or from paths the user types.

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

const ffmpegTool = require('./ffmpeg');
const { resolveInputs, locate } = require('./picker');
const { convert, selectEncoder, PROFILE_NAME } = require('./convert');

const ROOT = resolveRoot();
const OUTPUT_DIR = path.join(ROOT, 'output');
const PUBLIC_DIR = path.join(__dirname, 'public');

// node:sea tells a packaged build from a dev checkout reliably -- sniffing
// process.execPath for "node" breaks the moment someone renames the binary or
// runs it from a path that happens to contain the word.
function isPackaged() {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
}

function resolveRoot() {
  if (!isPackaged()) return path.resolve(__dirname, '..');

  // Inside a macOS .app the executable lives at
  // Bundle.app/Contents/MacOS/<exe>, and putting the user's folders there
  // would hide them inside the bundle. Climb out to the folder holding the
  // .app so output/ sits beside it, matching Windows.
  const exeDir = path.dirname(process.execPath);
  const bundle = exeDir.match(/^(.*\.app)[/\\]Contents[/\\]MacOS$/);
  return bundle ? path.dirname(bundle[1]) : exeDir;
}

let tools = null;      // {ffmpeg, ffprobe, source, version}
let encoder = null;    // chosen encoder descriptor
let installing = false;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

// One JSON object per line (NDJSON): simpler than SSE, and the client just
// splits on newlines.
function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  return (event) => {
    if (!res.writableEnded) res.write(JSON.stringify(event) + '\n');
  };
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function formatBytes(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(0) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' bytes';
}

// --- static files -----------------------------------------------------------

// In a packaged build the UI files are baked into the executable as SEA assets,
// so there is no public/ folder on disk to read from.
function readAsset(rel) {
  try {
    const sea = require('node:sea');
    if (sea.isSea()) {
      const buf = sea.getRawAsset(rel);
      return buf ? Buffer.from(buf) : null;
    }
  } catch { /* not a SEA build */ }
  return null;
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');

  let data = readAsset(rel);
  if (!data) {
    const target = path.join(PUBLIC_DIR, rel);
    // Refuse anything that escapes the public folder, however it was encoded.
    if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
      return json(res, 403, { error: 'forbidden' });
    }
    data = await fsp.readFile(target).catch(() => null);
  }

  if (!data) return json(res, 404, { error: 'not found' });

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

// --- api --------------------------------------------------------------------

function statusPayload() {
  return {
    ready: !!tools,
    installing,
    ffmpeg: tools ? { version: tools.version, source: tools.source } : null,
    encoder: encoder ? encoder.name : null,
    profile: PROFILE_NAME,
    outputDir: OUTPUT_DIR,
    canInstall: ffmpegTool.canInstall(),
    // Shown in the UI so the folder hint can use the right separator and give
    // a realistic example path.
    platform: process.platform,
    homeDir: require('os').homedir(),
  };
}

async function handleInstall(req, res) {
  if (tools) return json(res, 200, { ok: true, alreadyInstalled: true });
  if (installing) return json(res, 409, { error: 'an install is already running' });

  installing = true;
  const send = openStream(res);
  send({ type: 'log', message: 'Checking for ffmpeg...' });

  try {
    const result = await ffmpegTool.install((line) => send({ type: 'log', message: line }));
    if (!result.ok) {
      send({ type: 'error', message: result.error || 'install failed' });
    } else {
      tools = ffmpegTool.locate();
      if (!tools) {
        send({ type: 'error', message: 'ffmpeg installed but could not be located' });
      } else {
        send({ type: 'log', message: 'Checking which encoder this machine supports...' });
        encoder = selectEncoder(tools.ffmpeg, (line) => send({ type: 'log', message: line }));
        send({ type: 'done', status: statusPayload() });
      }
    }
  } catch (err) {
    send({ type: 'error', message: err.message });
  } finally {
    installing = false;
    res.end();
  }
}

/**
 * Turn typed or pasted locations into a queue of files.
 *
 * Accepts files and folders. Folders are expanded, optionally recursively,
 * which is how the UI turns "convert this whole folder" into a batch.
 */
async function handleResolve(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'invalid request body' });
  }

  const inputs = Array.isArray(payload && payload.paths) ? payload.paths : [];
  if (!inputs.length) return json(res, 400, { error: 'no paths given' });

  const only = Array.isArray(payload.only) ? payload.only : null;
  const files = await resolveInputs(inputs, !!payload.recursive, only);
  return json(res, 200, { files });
}

/**
 * Find files the browser could name but not locate.
 *
 * Used by the folder chooser and by drag-and-drop, both of which hand over
 * names without paths.
 */
async function handleLocate(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'invalid request body' });
  }

  const files = await locate({
    folderName: typeof payload.folderName === 'string' ? payload.folderName : undefined,
    fileNames: Array.isArray(payload.fileNames) ? payload.fileNames : undefined,
    sample: Array.isArray(payload.sample) ? payload.sample : undefined,
    recursive: !!payload.recursive,
    only: Array.isArray(payload.only) ? payload.only : undefined,
  });

  return json(res, 200, { files });
}

async function handleConvert(req, res) {
  if (!tools) return json(res, 409, { error: 'ffmpeg is not installed yet' });

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'invalid request body' });
  }

  const inputFile = typeof payload.path === 'string' ? path.resolve(payload.path) : null;
  if (!inputFile) return json(res, 400, { error: 'no file given' });

  let sourceStat;
  try {
    sourceStat = await fsp.stat(inputFile);
    if (!sourceStat.isFile()) throw new Error('not a file');
  } catch {
    return json(res, 404, { error: 'file not found' });
  }

  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  const outputFile = await uniqueOutputPath(inputFile);

  // Refusing to overwrite the source protects the one irreplaceable file in the
  // operation. It can only happen if the output folder is also the source
  // folder and the name already ends in _converted.mp4.
  if (path.resolve(outputFile) === inputFile) {
    return json(res, 400, { error: 'that file is already a converted output' });
  }

  const free = await freeSpace(OUTPUT_DIR);
  if (free !== null && free < sourceStat.size * 0.3) {
    return json(res, 507, {
      error:
        `not enough free space in ${OUTPUT_DIR}: ` +
        `only ${formatBytes(free)} available`,
    });
  }

  if (!encoder) encoder = selectEncoder(tools.ffmpeg);

  const send = openStream(res);
  const controller = new AbortController();
  // If the user closes the tab or cancels, stop burning CPU on an encode whose
  // result nobody will collect.
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  const result = await convert({
    ffmpeg: tools.ffmpeg,
    ffprobe: tools.ffprobe,
    inputFile,
    outputFile,
    encoder,
    onEvent: send,
    signal: controller.signal,
  });

  if (result.ok) {
    send({
      type: 'done',
      outputFile,
      outputName: path.basename(outputFile),
      outputUrl: pathToFileURL(outputFile).href,
      elapsed: result.elapsed,
      duration: result.duration,
    });
  } else if (!result.cancelled) {
    send({ type: 'error', message: result.error });
  }

  // A failed or cancelled run leaves a partial mp4 behind; drop it so output/
  // only ever contains files that finished.
  if (!result.ok) {
    await fsp.unlink(outputFile).catch(() => {});
  }
  res.end();
}

/**
 * Pick an output name that does not clobber an existing file.
 *
 * Two different sources can easily share a basename (episode1.mp4 from two
 * folders), and silently overwriting the first result would be the worst
 * possible outcome of a batch run.
 */
async function uniqueOutputPath(inputFile) {
  const base = path.basename(inputFile).replace(/\.[^.]+$/, '');
  let candidate = path.join(OUTPUT_DIR, `${base}_converted.mp4`);
  let n = 2;
  // The bound is a safety valve; nobody has 999 same-named sources, and an
  // unbounded loop here would hang on a pathological directory.
  while (n < 1000) {
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
    candidate = path.join(OUTPUT_DIR, `${base}_converted (${n}).mp4`);
    n++;
  }
  return candidate;
}

async function freeSpace(dir) {
  try {
    const stats = await fsp.statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

// Opening the output folder is the payoff of the whole UI, so it gets a button.
function revealFolder(dir) {
  const { spawn } = require('child_process');
  if (process.platform === 'win32') {
    spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
  }
}

// --- wiring -----------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname;

  const handle = async () => {
    if (route === '/api/status') return json(res, 200, statusPayload());
    if (route === '/api/install' && req.method === 'POST') return handleInstall(req, res);
    if (route === '/api/resolve' && req.method === 'POST') return handleResolve(req, res);
    if (route === '/api/locate' && req.method === 'POST') return handleLocate(req, res);
    if (route === '/api/convert' && req.method === 'POST') return handleConvert(req, res);

    if (route === '/api/reveal' && req.method === 'POST') {
      await fsp.mkdir(OUTPUT_DIR, { recursive: true });
      revealFolder(OUTPUT_DIR);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET') return serveStatic(req, res, route);
    return json(res, 405, { error: 'method not allowed' });
  };

  handle().catch((err) => {
    console.error('[server]', err.message);
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  });
});

async function start() {
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });

  tools = ffmpegTool.locate();
  if (tools) encoder = selectEncoder(tools.ffmpeg);

  // Port 0 lets the OS pick a free one, so a busy port never blocks startup.
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { port, url: `http://127.0.0.1:${port}` };
}

module.exports = { start, ROOT, OUTPUT_DIR };
