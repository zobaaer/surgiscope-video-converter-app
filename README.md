# Video Converter

Drag-and-drop GUI for the smart-cut conversion. Same profile as
`prepare-smart-cut.ps1` / `prepare-smart-cut.sh`. Windows and Mac.

## Using it

1. Put the app in a folder of its own and double-click it. A console window
   opens and the app appears in your browser.
2. First time only: click **Install ffmpeg**. No admin rights needed.
3. Click the box, pick your videos. Nothing is copied — each file is read where
   it sits.
4. Converted files land in `output/`, beside the app. **Open folder** takes you
   there.

Keep the console window open while converting; closing it quits the app. Needs
an internet connection for the first install step, nothing else.

**First run warning.** Neither build is signed, so each system warns once. On
Windows: *More info* → *Run anyway*. On Mac: right-click the app → *Open*.

**Mac: move the app before opening it.** If you received the `.app` from
someone else (AirDrop, Slack, a download link, etc.) rather than building it
yourself, macOS marks it quarantined and — since it isn't notarized — runs it
from a hidden, read-only, randomized location instead of where it actually
sits ("App Translocation"). The app can't create `output/`/`bin/` there and
fails with an `ENOENT` on startup. Fix it with either:

- Drag `Video Converter.app` to another folder (e.g. `Applications` or the
  Desktop) *before* opening it — moving it once is enough, even if you move it
  right back.
- Or in Terminal: `xattr -cr "/path/to/Video Converter.app"`, then open it
  normally.

## The conversion

Profile `smart-cut-h264-aac-cq28-gop30-v1`:

- H.264 Main, `yuv420p`, quality 28, capped at 5 Mbit/s
- keyframe every 30 frames, no scene-cut keyframes, closed GOP
- AAC 160 kbit/s, 48 kHz, stereo
- `+faststart`, tagged `smart_cut_profile=...` so `smart-cut` skips it

Outputs are checked against the source duration; drift over 0.25 s counts as a
failure and the file is deleted.

**Encoders.** Tries `h264_videotoolbox` (Mac), `h264_nvenc`, `h264_qsv`,
`h264_amf`, then `libx264`. Unlike the shell scripts it runs a one-second test
encode before committing — `ffmpeg -encoders` lists what ffmpeg was *compiled*
with, not what the machine can run, so an Intel-GPU PC advertises `h264_nvenc`
and then dies on `Cannot load nvcuda.dll`.

**Windows and Mac output are not byte-identical.** Same profile, same handling
by `smart-cut`, but different hardware encoders produce different bytes. Making
them identical would mean `libx264` everywhere and no hardware acceleration.

## Building

Needs Node.js 20+.

```
npm run build
```

Windows: `dist/VideoConverter.exe` (81 MB), the single file to ship. Mac:
`dist/Video Converter.app` — ship the whole bundle.

**Build each platform on that platform** — the build embeds the Node binary it
runs under. On Mac that binary's architecture matters: an arm64 app will not
launch on Intel. Use `npm run build -- --universal` (needs both Node builds) or
`arch -x86_64 npm run build`. The ffmpeg downloaded on first run always matches
the machine.

`npm start` runs from source without packaging.

## How it works

`build.js` inlines the local modules into one script and uses Node's
single-executable-application support to append it, plus `public/` as SEA
assets, to a copy of the Node binary. No runtime dependencies.

| File         | Role                                        |
| ------------ | ------------------------------------------- |
| `main.js`    | starts the server, opens the browser        |
| `server.js`  | HTTP API and static hosting                 |
| `convert.js` | ffmpeg invocation and progress parsing      |
| `ffmpeg.js`  | locating and installing ffmpeg              |
| `picker.js`  | turning browser-supplied names into paths   |
| `public/`    | the UI                                      |

**File locations.** Browsers expose a file's name but never its path. So the app
searches for the chosen names in the usual places — Videos, Movies, Desktop,
Downloads, Documents, Pictures, the home folder, and fixed drives C–H on
Windows — two levels deep, skipping system folders. If a file is somewhere
unusual the app asks for the folder. Only the selected files are queued.

Nothing is written to a temp folder and executed. An earlier version generated a
PowerShell script for a native file dialog, which antivirus reasonably flagged.

**Notes.**

- Binds to `127.0.0.1` on an OS-assigned port: unreachable from the network,
  never collides.
- Sources are read in place, never copied, so there is no `input/` folder. A
  failed or cancelled run deletes its own partial output.
- Refuses a job if the output drive has less than 30% of the source size free.
- Same-named sources become `name_converted (2).mp4` rather than overwriting.
- An ffmpeg on `PATH` is used as-is; otherwise a static build is unpacked into
  `bin/`, falling back to winget (Windows) or Homebrew (Mac). Windows builds
  from BtbN, Mac from osxexperts.net and evermeet.cx.
- One file at a time — parallel encodes are slower without finishing sooner.
