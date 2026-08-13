'use strict';

// The conversion itself. This is a port of prepare-smart-cut.ps1 / .sh, with
// one deliberate difference noted at selectEncoder().

const { spawn, spawnSync } = require('child_process');
const path = require('path');

const PROFILE_NAME = 'smart-cut-h264-aac-cq28-gop30-v1';

// Ordered fastest-first, same preference as the scripts, with the Apple
// hardware encoder added for macOS.
//
// Every entry targets the same profile: H.264 Main, quality ~28, capped around
// 5 Mbit/s. The knob names differ per encoder because each vendor spells
// constant-quality differently -- -cq for nvenc, -global_quality for qsv,
// -qp_i/-qp_p for amf, -q:v for videotoolbox, -crf for libx264 -- but the
// intent is identical.
const ENCODERS = [
  {
    // Apple Silicon and modern Intel Macs both expose VideoToolbox, and it is
    // the only hardware path on macOS, so it goes first. -q:v is only honoured
    // in constant-quality mode, which is why -b:v is left off here: setting a
    // bitrate would silently switch the encoder to ABR and ignore the quality
    // target. The realtime=0 flag trades a little speed for better quality.
    name: 'h264_videotoolbox',
    args: ['-c:v', 'h264_videotoolbox', '-q:v', '55', '-realtime', '0',
           '-maxrate', '5M', '-bufsize', '10M'],
  },
  {
    name: 'h264_nvenc',
    args: ['-c:v', 'h264_nvenc', '-preset', 'fast', '-rc', 'vbr', '-cq', '28',
           '-b:v', '3M', '-maxrate', '5M', '-bufsize', '10M', '-forced-idr', '1'],
  },
  {
    name: 'h264_qsv',
    args: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '28',
           '-b:v', '3M', '-maxrate', '5M', '-bufsize', '10M'],
  },
  {
    name: 'h264_amf',
    args: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '28',
           '-qp_p', '28', '-b:v', '3M', '-maxrate', '5M', '-bufsize', '10M'],
  },
  {
    name: 'libx264',
    args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
           '-maxrate', '5M', '-bufsize', '10M',
           '-x264-params', 'keyint=30:min-keyint=30:scenecut=0:open-gop=0'],
  },
];

/**
 * Pick a hardware encoder that actually runs on this machine.
 *
 * The shell scripts grep `ffmpeg -encoders` and take the first hit, but that
 * list reports what ffmpeg was *compiled* with, not what the current GPU and
 * drivers support. On a machine with an Intel GPU, a build with nvenc compiled
 * in still advertises h264_nvenc and then dies at runtime with
 * "Cannot load nvcuda.dll". Since this app ships to machines we have never
 * seen, compile-time presence is not good enough -- each candidate gets a real
 * one-second encode and the first one that survives wins. libx264 is last and
 * always works, so the loop cannot come up empty.
 */
function selectEncoder(ffmpegPath, log) {
  const listed = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const available = listed.stdout || '';

  for (const enc of ENCODERS) {
    if (enc.name !== 'libx264' && !available.includes(enc.name)) continue;

    // The probe mirrors the real encode closely enough to catch a driver that
    // is missing at runtime. -pix_fmt matters here: videotoolbox rejects the
    // default format that testsrc produces, so leaving it out would make a
    // perfectly good encoder look broken.
    const probe = spawnSync(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error',
       '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=1',
       ...enc.args,
       '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-g', '30',
       '-f', 'null', '-'],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 }
    );

    if (probe.status === 0) {
      if (log) log(`Using encoder: ${enc.name}`);
      return enc;
    }
    if (log && enc.name !== 'libx264') {
      const why = (probe.stderr || '').trim().split('\n').pop() || 'probe failed';
      log(`${enc.name} is present but not usable (${why}) - trying the next one.`);
    }
  }

  return ENCODERS[ENCODERS.length - 1];
}

function probeDuration(ffprobePath, file) {
  const r = spawnSync(
    ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration',
     '-of', 'default=noprint_wrappers=1:nokey=1', file],
    { encoding: 'utf8', windowsHide: true }
  );
  if (r.status !== 0) return 0;
  const value = parseFloat((r.stdout || '').trim());
  return Number.isFinite(value) ? value : 0;
}

function buildArgs(encoder, inputFile, outputFile) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputFile,
    '-map', '0:v:0', '-map', '0:a:0?',
    ...encoder.args,
    '-profile:v', 'main',
    '-pix_fmt', 'yuv420p',
    '-g', '30',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '48000',
    '-ac', '2',
    // +use_metadata_tags is required for the MP4 muxer to keep a non-standard
    // key like smart_cut_profile. Without it the tag is silently dropped and
    // smart-cut.sh's fast path never matches.
    '-movflags', '+faststart+use_metadata_tags',
    '-metadata', `smart_cut_profile=${PROFILE_NAME}`,
    '-progress', 'pipe:1',
    '-nostats',
    outputFile,
  ];
}

/**
 * Convert one file.
 * @param {object} opts
 * @param {string} opts.ffmpeg       path to ffmpeg
 * @param {string} opts.ffprobe      path to ffprobe
 * @param {string} opts.inputFile    absolute source path
 * @param {string} opts.outputFile   absolute destination path
 * @param {object} opts.encoder      chosen encoder descriptor
 * @param {(e:object)=>void} opts.onEvent progress sink
 * @param {AbortSignal} [opts.signal]
 */
function convert({ ffmpeg, ffprobe, inputFile, outputFile, encoder, onEvent, signal }) {
  return new Promise((resolve) => {
    const duration = probeDuration(ffprobe, inputFile);
    const started = Date.now();

    onEvent({
      type: 'start',
      name: path.basename(inputFile),
      duration,
      encoder: encoder.name,
      profile: PROFILE_NAME,
    });

    const child = spawn(ffmpeg, buildArgs(encoder, inputFile, outputFile), {
      windowsHide: true,
    });

    let lastPercent = -1;
    let speed = '';
    let stderrTail = '';
    let stdoutBuf = '';

    child.stdout.on('data', (buf) => {
      stdoutBuf += buf;
      const lines = stdoutBuf.split(/\r?\n/);
      // Keep the trailing fragment; ffmpeg writes key=value pairs continuously
      // and a chunk boundary can land mid-line.
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('out_time_us=') || line.startsWith('out_time_ms=')) {
          const micros = parseFloat(line.split('=')[1]);
          if (!Number.isFinite(micros) || !duration) continue;
          const seconds = micros / 1e6;
          const percent = Math.max(0, Math.min(100, Math.floor((seconds / duration) * 100)));
          if (percent > lastPercent) {
            lastPercent = percent;
            onEvent({ type: 'progress', percent, seconds, duration, speed });
          }
        } else if (line.startsWith('speed=')) {
          speed = line.split('=')[1].trim();
        }
      }
    });

    child.stderr.on('data', (buf) => {
      // Only the tail is useful for a failure message, and capping it keeps a
      // pathological run from growing without bound.
      stderrTail = (stderrTail + buf).slice(-4000);
    });

    const onAbort = () => child.kill('SIGKILL');
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ ok: false, error: `could not run ffmpeg: ${err.message}` });
    });

    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);

      if (signal && signal.aborted) {
        return resolve({ ok: false, cancelled: true, error: 'cancelled' });
      }
      if (code !== 0) {
        const detail = stderrTail.trim().split('\n').pop() || `exit code ${code}`;
        return resolve({ ok: false, error: detail });
      }

      // Same guard the scripts apply: a truncated encode is the failure mode
      // that most easily passes for success.
      const actual = probeDuration(ffprobe, outputFile);
      const diff = Math.abs(actual - duration);
      if (duration && diff > 0.25) {
        return resolve({
          ok: false,
          error: `output duration differs by ${diff.toFixed(3)}s (source ${duration.toFixed(3)}s, output ${actual.toFixed(3)}s)`,
        });
      }

      resolve({
        ok: true,
        elapsed: (Date.now() - started) / 1000,
        duration: actual,
        outputFile,
      });
    });
  });
}

module.exports = { convert, selectEncoder, probeDuration, PROFILE_NAME };
