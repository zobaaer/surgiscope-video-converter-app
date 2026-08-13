# Video Converter

A drag-and-drop GUI for the smart-cut conversion, producing the same profile as
`prepare-smart-cut.ps1` / `prepare-smart-cut.sh`. Runs on Windows and Mac with
the same interface and settings on both.

## Using it

1. Copy the app into a folder of its own — `VideoConverter.exe` on Windows,
   `Video Converter.app` on Mac — and double-click it. A console window opens
   and the app appears in your browser.
2. The first time, click **Install ffmpeg**. It downloads once, needs no admin
   rights, and takes a few seconds.
3. Click the box and select your videos, as many as you like. Nothing is copied;
   each file is read where it sits.
4. A header tracks the batch (**Video 3 of 8**) with an overall bar and an
   estimate, while each file shows its own percentage, time remaining and
   encoding speed. **Stop after this file** ends the batch without killing the
   conversion in progress.
5. Converted files land in `output/`, beside the app. **Open folder** takes you
   there.

Keep the console window open while converting; closing it quits the app.
Nothing needs installing beforehand — no Node.js, no ffmpeg, no admin rights.
The only requirement is an internet connection for that first install step.

### First run warnings

Neither build is signed with a paid developer certificate, so each system warns
once:

- **Windows** — "Windows protected your PC": *More info* → *Run anyway*.
- **Mac** — "unidentified developer": right-click the app, choose *Open*, then
  confirm. Once is enough.

### Folders

`output/` (the `*_converted.mp4` files) and `bin/` (the downloaded ffmpeg) are
both created automatically beside the app — on Mac beside `Video Converter.app`,
not inside it.

Sources are never copied, so there is no `input/` folder and no second copy of a
large file. If two sources share a name, the second output becomes
`name_converted (2).mp4` rather than overwriting the first.

### How files are located

Browsers deliberately hide where a file lives: a picked or dropped file exposes
its name but never its path. That is a security boundary, not a setting, and an
earlier attempt to work around it with a native dialog meant spawning
PowerShell — which antivirus blocked, and rightly so.

Instead the app searches for the chosen names where videos actually live: the
user's Videos, Movies, Desktop, Downloads, Documents and Pictures folders, the
home folder itself, and fixed drive roots C–H on Windows, each to two levels
deep. System and application folders are skipped. This usually resolves
everything in well under a second.

If a file is somewhere unusual the app asks for the folder — pasted as a path,
or chosen with a folder picker. Only the originally selected files are queued,
never everything else in that folder.

## What the conversion does

Profile `smart-cut-h264-aac-cq28-gop30-v1`, matching the shell scripts:

- H.264, Main profile, `yuv420p`, quality 28, capped at 5 Mbit/s
- a keyframe every 30 frames, no scene-cut keyframes, closed GOP
- AAC audio, 160 kbit/s, 48 kHz, stereo
- `+faststart` so playback can begin before the file is fully loaded
- tagged `smart_cut_profile=...` so `smart-cut` skips re-converting it

Every output is checked against its source duration; a file that drifts by more
than 0.25 s is treated as failed and deleted rather than left in `output/`
looking finished.

### Encoder selection

The app considers `h264_videotoolbox` (Mac), `h264_nvenc`, `h264_qsv`,
`h264_amf` and finally `libx264`. Like the shell scripts it skips anything
absent from `ffmpeg -encoders`, but it then runs a real one-second test encode
before committing.

That extra step is the deliberate difference. The encoder list reports what
ffmpeg was *compiled* with, not what the machine can run: on a PC with an Intel
GPU, a build with NVIDIA support still advertises `h264_nvenc` and then fails
with `Cannot load nvcuda.dll`. On the development machine this is not
hypothetical — the scripts pick `h264_nvenc` and fail, while the app falls
through to `h264_qsv`.

### Windows and Mac output are not byte-identical

Both platforms produce the same *profile* — codecs, resolution, pixel format,
audio, GOP length and metadata tag all match, and `smart-cut` treats the two
identically. The compressed bytes differ because the encoding is done by
different hardware, and two silicon encoders aiming at the same quality target
do not produce identical bitstreams. Forcing `libx264` everywhere would fix that
at the cost of hardware acceleration on both platforms; matching the profile is
what matters downstream.

## Building

Requires Node.js 20 or newer, only to build.

```
npm run build
```

On Windows that produces `dist/VideoConverter.exe` (~85 MB), the single file to
distribute. On Mac it produces `dist/Video Converter.app` — distribute the whole
bundle, zipped if you are sending it somewhere.

**Each platform must be built on that platform.** The build embeds a copy of the
Node binary it is running under, so Windows cannot produce the Mac app.

### A Mac app that runs on every Mac

The embedded Node binary has an architecture, so building on Apple Silicon
yields an arm64 app that will **not** launch on an Intel Mac. The reverse is
safe: an x64 app runs everywhere, on Apple Silicon through Rosetta 2.
`npm run build` warns when it produces an architecture-specific Mac app.

- **Best — universal, native on both.** Needs both Node builds present; merged
  with `lipo`:

  ```
  npm run build -- --universal
  ```

- **Simplest — build on an Intel Mac**, or with an x64 Node under Rosetta:

  ```
  arch -x86_64 npm run build
  ```

Either way the ffmpeg downloaded on first run is chosen at runtime to match the
machine, so an Apple Silicon user still gets native arm64 ffmpeg and full
hardware encoding.

To run from source without packaging: `npm start`. In that mode `output/` is
created in the parent of the project folder, and `bin/` in the project folder
itself.

### How the packaging works

`build.js` inlines the local modules into one script, then uses Node's
single-executable-application support to append it — plus the `public/` UI files
as SEA assets — to a copy of the Node binary. There are no runtime npm
dependencies; `postject` is fetched by `npx` during the build only.

### Layout

| File         | Role                                              |
| ------------ | ------------------------------------------------- |
| `main.js`    | entry point; starts the server, opens the browser |
| `server.js`  | HTTP API and static hosting                       |
| `convert.js` | ffmpeg invocation and progress parsing            |
| `ffmpeg.js`  | locating and installing ffmpeg                    |
| `picker.js`  | resolving names the browser gave into real paths  |
| `public/`    | the UI                                            |
| `build.js`   | produces the packaged app                         |

### Notes

- The server binds to `127.0.0.1` on a port the OS picks, so it is unreachable
  from the network and never collides with something already listening.
- Sources are read in place and never copied, so an interrupted run cannot leave
  a half-written file anywhere. A failed or cancelled conversion deletes its own
  partial output.
- A conversion is refused up front if the output drive has less than 30% of the
  source's size free.
- An ffmpeg already on `PATH` is used as-is. Otherwise the installer unpacks a
  static build into `bin/`, falling back to winget on Windows or Homebrew on Mac
  if the download fails. Windows builds come from BtbN (the ones ffmpeg.org
  points at); Mac builds from osxexperts.net and evermeet.cx.
- Nothing is written to a temp folder and executed. An earlier version generated
  a PowerShell script to show a file dialog, which antivirus reasonably treated
  as malware; file selection is now pure browser code.
- Files are converted one at a time. Running several encodes at once makes them
  all slower without finishing any sooner.
