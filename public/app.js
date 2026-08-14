'use strict';

// Client for the converter GUI. Plain script, no modules or build step, so it
// runs the same whether it is served from the packaged app or opened during
// development.
//
// Sources are never uploaded. The server reads each file from wherever it
// already lives, so the only thing crossing the wire is a path and a stream of
// progress events.

const el = (id) => document.getElementById(id);

const dropzone = el('dropzone');
const fileInput = el('fileInput');
const folderInput = el('folderInput');
const pathbox = el('pathbox');
const pathboxLabel = el('pathboxLabel');
const pathboxHint = el('pathboxHint');
const pathInput = el('pathInput');
const pathAdd = el('pathAdd');
const pickFolderBtn = el('pickFolderBtn');
const queue = el('queue');
const setup = el('setup');
const setupText = el('setupText');
const installBtn = el('installBtn');
const installLog = el('installLog');
const statusDot = el('statusDot');
const toolInfo = el('toolInfo');
const outputPath = el('outputPath');
const revealBtn = el('revealBtn');

const batch = el('batch');
const batchLabel = el('batchLabel');
const batchMeta = el('batchMeta');
const batchFill = el('batchFill');
const batchCurrent = el('batchCurrent');
const cancelBtn = el('cancelBtn');

let ready = false;

const VIDEO_EXT =
  /\.(mp4|mov|mkv|avi|m4v|webm|mpg|mpeg|wmv|flv|ts|m2ts|mts|3gp|ogv)$/i;
// Files are converted one at a time. Running several encodes at once just makes
// them all slower and turns the progress bars into noise.
let working = false;
let stopRequested = false;
const pending = [];
// The AbortController behind whichever fetch is currently mid-conversion, so
// Cancel can stop it immediately instead of waiting for it to finish.
let currentAbort = null;

// Batch bookkeeping, so the header can say "Video 3 of 8".
const batchState = { total: 0, done: 0, failed: 0, startedAt: 0 };

// --- status -----------------------------------------------------------------

async function refreshStatus() {
  try {
    const status = await (await fetch('api/status')).json();
    applyStatus(status);
    return status;
  } catch {
    setDot('error');
    toolInfo.textContent = 'Cannot reach the app service';
    return null;
  }
}

function applyStatus(status) {
  ready = status.ready;
  outputPath.textContent = status.outputDir;

  // Show an example in the platform's own path style.
  if (status.homeDir) {
    const sep = status.platform === 'win32' ? '\\' : '/';
    pathInput.placeholder = status.homeDir + sep + 'Videos';
  }

  if (ready) {
    setup.classList.add('hidden');
    dropzone.classList.remove('disabled');
    setDot(working ? 'busy' : 'ready');
    const enc = status.encoder ? ` - ${status.encoder}` : '';
    toolInfo.textContent = `ffmpeg ${shortVersion(status.ffmpeg.version)}${enc}`;
  } else {
    setup.classList.remove('hidden');
    dropzone.classList.add('disabled');
    setDot('error');
    toolInfo.textContent = 'ffmpeg not installed';
    if (!status.canInstall) {
      setupText.textContent =
        'This app needs ffmpeg, and there is no automatic installer for this ' +
        'system. Please install ffmpeg yourself, then restart the app.';
      installBtn.classList.add('hidden');
    }
  }
}

// Build strings carry build tags and vendor URLs; keep just the version.
function shortVersion(v) {
  const m = /^n?(\d+\.\d+(?:\.\d+)?)/.exec(String(v || ''));
  return m ? m[1] : String(v || '').split('-')[0];
}

function setDot(state) {
  statusDot.className = 'dot' + (state ? ' ' + state : '');
}

// --- install ----------------------------------------------------------------

installBtn.addEventListener('click', async () => {
  installBtn.disabled = true;
  installBtn.textContent = 'Installing...';
  installLog.classList.remove('hidden');
  installLog.textContent = '';
  setDot('busy');

  const appendLog = (line) => {
    installLog.textContent += line + '\n';
    installLog.scrollTop = installLog.scrollHeight;
  };

  try {
    const res = await fetch('api/install', { method: 'POST' });
    await readStream(res, (event) => {
      if (event.type === 'log') appendLog(event.message);
      else if (event.type === 'error') appendLog('Error: ' + event.message);
      else if (event.type === 'done') applyStatus(event.status);
    });
  } catch (err) {
    appendLog('Error: ' + err.message);
  }

  const status = await refreshStatus();
  if (!status || !status.ready) {
    installBtn.disabled = false;
    installBtn.textContent = 'Try again';
    appendLog('');
    appendLog('ffmpeg could not be installed automatically. Check the internet');
    appendLog('connection and try again.');
  }
});

/** Read an NDJSON response, invoking onEvent for each complete line. */
async function readStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    // The last element is an incomplete line unless the chunk ended exactly on
    // a newline; either way it belongs back in the buffer.
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line));
      } catch { /* ignore a malformed line rather than kill the stream */ }
    }
  }
}

// --- choosing files ---------------------------------------------------------

dropzone.addEventListener('click', choose);
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    choose();
  }
});

function choose() {
  if (!ready) return;
  fileInput.click();
}

fileInput.addEventListener('change', () => {
  const picked = [...fileInput.files];
  // Reset so picking the same file twice still fires a change event.
  fileInput.value = '';
  if (picked.length) locateAndQueue(picked.map((f) => f.name));
});

/**
 * Turn chosen file names into real paths.
 *
 * A browser hands over a name but never a location, so the server searches the
 * usual places for it. That succeeds for anything under the user's own folders;
 * whatever is left over is asked about explicitly.
 */
async function locateAndQueue(names) {
  setBusyChoosing(true);
  try {
    const res = await fetch('api/locate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileNames: names }),
    });
    const data = await res.json().catch(() => ({}));
    const found = (data && data.files) || [];

    if (found.length) enqueue(found);

    const foundNames = new Set(found.map((f) => f.name));
    const missing = names.filter((n) => !foundNames.has(n));
    if (missing.length) askForLocation(missing);
    else hidePathBox();
  } catch (err) {
    note('Could not locate those files: ' + err.message);
  } finally {
    setBusyChoosing(false);
  }
}

function setBusyChoosing(on) {
  dropzone.classList.toggle('disabled', on);
  dropzone.querySelector('.drop-title').textContent =
    on ? 'Looking for those files...' : 'Choose videos';
}

// --- locating the ones we could not find ------------------------------------

// Names still waiting to be located, so a supplied folder can be re-searched.
let awaitingNames = [];

function askForLocation(names) {
  awaitingNames = names;
  pathbox.classList.remove('hidden');
  pathboxLabel.textContent =
    names.length === 1 ? 'Where is that file?' : `Where are those ${names.length} files?`;
  pathboxHint.textContent =
    `Your browser does not say where ${names.length === 1 ? 'it is' : 'they are'}: ` +
    names.slice(0, 3).join(', ') + (names.length > 3 ? ', ...' : '') +
    '. Paste the folder they are in, or choose it below.';
  pathInput.focus();
}

function hidePathBox() {
  awaitingNames = [];
  pathbox.classList.add('hidden');
  pathInput.value = '';
}

/** Resolve the waiting names inside a folder the user just identified. */
async function resolveIn(folder) {
  const res = await fetch('api/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Naming the files explicitly keeps a folder of 200 videos from queueing
    // all of them when the user only picked three.
    body: JSON.stringify({ paths: [folder], only: awaitingNames }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    note(data.error || 'could not read that folder');
    return;
  }
  if (!data.files || !data.files.length) {
    note('Those files are not in that folder.');
    return;
  }
  enqueue(data.files);
  hidePathBox();
}

pathAdd.addEventListener('click', () => {
  const raw = pathInput.value.trim();
  if (raw) resolveIn(raw);
});
pathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const raw = pathInput.value.trim();
    if (raw) resolveIn(raw);
  }
});

// Picking the folder reveals its name, which is enough for the server to find
// it -- an easier ask than typing a full path.
pickFolderBtn.addEventListener('click', () => folderInput.click());

folderInput.addEventListener('change', async () => {
  const files = [...folderInput.files];
  folderInput.value = '';
  if (!files.length) return;

  const folderName = (files[0].webkitRelativePath || '').split('/')[0];
  if (!folderName) return;

  setBusyChoosing(true);
  try {
    const res = await fetch('api/locate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folderName,
        // A sample confirms the right folder was found rather than a different
        // one that happens to share the name.
        sample: files.slice(0, 8).map((f) => f.webkitRelativePath || f.name),
        only: awaitingNames.length ? awaitingNames : undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.files && data.files.length) {
      enqueue(data.files);
      hidePathBox();
    } else {
      note(`Could not work out where "${folderName}" is. Paste its full path instead.`);
    }
  } finally {
    setBusyChoosing(false);
  }
});

for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.remove('over');
  });
}

// The whole window swallows drops so a near-miss does not make the browser
// navigate away and replace the app with the video.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

dropzone.addEventListener('drop', async (e) => {
  if (!ready) return;

  const dropped = [...(e.dataTransfer.files || [])];
  const videos = dropped.filter((f) => VIDEO_EXT.test(f.name));
  if (!videos.length) return;

  // A dropped file carries a name but no location, exactly like a picked one,
  // so it goes through the same lookup.
  locateAndQueue(videos.map((f) => f.name));
});

function enqueue(files) {
  if (!files || !files.length) return;

  const usable = [];
  for (const entry of files) {
    if (entry.error) {
      const item = addItem(entry.name, entry.path);
      item.setState('Cannot read');
      item.setNote(escapeHtml(entry.error));
      item.finish('error');
      batchState.failed++;
      continue;
    }
    usable.push(entry);
  }

  for (const entry of usable) {
    pending.push({ entry, ui: addItem(entry.name, entry.path, entry.size) });
    batchState.total++;
  }

  updateBatch();
  pump();
}

function note(message) {
  const div = document.createElement('div');
  div.className = 'item';
  div.innerHTML = '<p class="item-note"></p>';
  div.querySelector('.item-note').textContent = message;
  queue.prepend(div);
  setTimeout(() => div.remove(), 9000);
}

// --- queue ------------------------------------------------------------------

function addItem(name, fullPath, size) {
  const div = document.createElement('div');
  div.className = 'item';
  div.innerHTML = `
    <div class="item-head">
      <span class="item-name"></span>
      <span class="item-state">Waiting</span>
    </div>
    <div class="item-path"></div>
    <div class="track"><div class="fill"></div></div>
    <p class="item-note hidden"></p>`;

  div.querySelector('.item-name').textContent = name;
  const pathEl = div.querySelector('.item-path');
  pathEl.textContent = size !== undefined
    ? `${fullPath}  ·  ${formatBytes(size)}`
    : fullPath || '';

  queue.append(div);

  const state = div.querySelector('.item-state');
  const fill = div.querySelector('.fill');
  const noteEl = div.querySelector('.item-note');

  return {
    element: div,
    setState: (text) => { state.textContent = text; },
    setPercent: (pct) => { fill.style.width = pct + '%'; },
    setActive: (on) => { div.classList.toggle('active', on); },
    setNote: (html) => {
      noteEl.innerHTML = html;
      noteEl.classList.remove('hidden');
    },
    finish: (kind) => {
      div.classList.remove('active');
      div.classList.add(kind);
      if (kind === 'done') fill.style.width = '100%';
    },
  };
}

/** Refresh the "Video 3 of 8" header and the overall bar. */
function updateBatch(currentName, currentPercent) {
  const finished = batchState.done + batchState.failed;
  const total = batchState.total + batchState.failed;

  if (!total) {
    batch.classList.add('hidden');
    return;
  }
  batch.classList.remove('hidden');

  if (working) {
    // The file being worked on is the one after everything already finished.
    const index = Math.min(batchState.done + 1, batchState.total);
    batchLabel.textContent = `Video ${index} of ${batchState.total}`;
  } else {
    batchLabel.textContent =
      finished === total
        ? `Finished ${batchState.done} of ${total}`
        : `${total} video${total === 1 ? '' : 's'} queued`;
  }

  // Overall progress counts each completed file as whole and adds the fraction
  // of the one in flight, so the bar advances smoothly rather than in jumps.
  const inFlight = typeof currentPercent === 'number' ? currentPercent / 100 : 0;
  const overall = batchState.total
    ? ((batchState.done + inFlight) / batchState.total) * 100
    : 0;
  batchFill.style.width = Math.min(100, overall) + '%';

  const bits = [];
  if (batchState.done) bits.push(`${batchState.done} done`);
  if (batchState.failed) bits.push(`${batchState.failed} failed`);
  if (working && batchState.startedAt && batchState.done) {
    const each = (performance.now() - batchState.startedAt) / batchState.done;
    const left = each * (batchState.total - batchState.done);
    if (Number.isFinite(left) && left > 0) bits.push(`about ${formatTime(left / 1000)} left`);
  }
  batchMeta.textContent = bits.join('  ·  ');
  batchCurrent.textContent = working && currentName ? currentName : '';
}

cancelBtn.addEventListener('click', () => {
  stopRequested = true;
  cancelBtn.disabled = true;
  cancelBtn.textContent = 'Cancelling...';
  // Stop the file in flight right away rather than waiting for it to finish;
  // the server drops its partial output once it sees the request end.
  if (currentAbort) currentAbort.abort();
  // Anything not yet started can be dropped immediately.
  while (pending.length) {
    const job = pending.shift();
    job.ui.setState('Skipped');
    job.ui.finish('error');
    batchState.total--;
  }
  updateBatch();
});

async function pump() {
  if (working || !pending.length) return;
  working = true;
  stopRequested = false;
  cancelBtn.disabled = false;
  cancelBtn.textContent = 'Cancel';
  batchState.startedAt = performance.now();
  setDot('busy');

  while (pending.length && !stopRequested) {
    const job = pending.shift();
    job.ui.setActive(true);
    try {
      await runJob(job);
      batchState.done++;
    } catch (err) {
      if (err.name === 'AbortError') {
        job.ui.setState('Cancelled');
        job.ui.finish('error');
        batchState.total--;
      } else {
        job.ui.setState('Failed');
        job.ui.setNote(escapeHtml(err.message));
        job.ui.finish('error');
        batchState.failed++;
        batchState.total--;
      }
    }
    updateBatch();
  }

  working = false;
  setDot('ready');
  updateBatch();

  if (batchState.done || batchState.failed) {
    cancelBtn.classList.add('hidden');
  }
}

async function runJob({ entry, ui }) {
  ui.setPercent(0);
  ui.setState('Starting...');

  const controller = new AbortController();
  currentAbort = controller;

  try {
    const res = await fetch('api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: entry.path }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error((await res.json().catch(() => ({}))).error || 'conversion failed');
    }

    const eta = createEta();
    let failure = null;

    await readStream(res, (event) => {
      if (event.type === 'progress') {
        ui.setPercent(event.percent);
        // Progress is reported in seconds of video encoded, so "done" and "total"
        // for the estimator are media seconds rather than bytes.
        const left = event.duration ? eta.update(event.seconds, event.duration) : '';
        const speed = event.speed ? ` (${event.speed})` : '';
        ui.setState(`${event.percent}%${left}${speed}`);
        updateBatch(entry.name, event.percent);
      } else if (event.type === 'done') {
        ui.setPercent(100);
        ui.setState(`Done in ${formatTime(event.elapsed)}`);
        ui.setNote(`Saved as <code>${escapeHtml(event.outputName)}</code>`);
        ui.finish('done');
      } else if (event.type === 'error') {
        failure = event.message;
      }
    });

    if (failure) throw new Error(failure);
  } finally {
    currentAbort = null;
  }
}

/**
 * Running ETA estimator.
 *
 * Rates are smoothed with an exponential moving average, because a raw
 * instantaneous rate makes the estimate jump around so much it is useless.
 * The first sample seeds the average outright -- blending it with a zero
 * starting value would make every ETA start out wildly too high.
 */
function createEta() {
  let startedAt = null;
  let rate = null;
  let lastShown = '';
  let lastShownAt = 0;

  return {
    update(done, total) {
      const now = performance.now();
      if (startedAt === null) {
        startedAt = now;
        return '';
      }

      const elapsed = (now - startedAt) / 1000;
      if (elapsed <= 0 || done <= 0 || total <= 0 || done > total) return lastShown;

      const instant = done / elapsed;
      rate = rate === null ? instant : rate * 0.7 + instant * 0.3;

      const remaining = (total - done) / rate;
      if (!Number.isFinite(remaining) || remaining < 0) return lastShown;

      // Recomputing the text every event makes the number flicker; once a
      // second is frequent enough to feel live and steady enough to read.
      if (now - lastShownAt < 1000 && lastShown) return lastShown;
      lastShownAt = now;
      lastShown = ` - ${formatTime(remaining)} left`;
      return lastShown;
    },
  };
}

function formatTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatBytes(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(0) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' bytes';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

// --- misc -------------------------------------------------------------------

revealBtn.addEventListener('click', () => {
  fetch('api/reveal', { method: 'POST' }).catch(() => {});
});

// Leaving mid-encode would abort it, so make that an explicit choice.
window.addEventListener('beforeunload', (e) => {
  if (working) {
    e.preventDefault();
    e.returnValue = '';
  }
});

refreshStatus();
