# Video Converter

A drag-and-drop GUI for the smart-cut conversion. Produces exactly the same
output as `prepare-smart-cut.ps1` / `prepare-smart-cut.sh`.

Runs on Windows and on Mac, with the same interface and the same conversion
settings on both.

## For the person using it

1. Copy the app into a folder of its own — `VideoConverter.exe` on Windows,
   `Video Converter.app` on Mac.
2. Double-click it. A console window opens (Terminal, on Mac) and the app
   appears in your browser.
3. The first time, click **Install ffmpeg**. It downloads 25–90 MB depending on
   the platform and takes a few seconds. No administrator rights are needed, and
   it only happens once.
4. Click the box and select your video files — as many at once as you like.
   Nothing is copied or moved; each file is read from where it already sits.
5. A header tracks the batch (**Video 3 of 8**) with an overall bar and an
   estimate for the whole run, while each file below shows its own percentage,
   time remaining and encoding speed. **Stop after this file** ends the batch
   cleanly without killing the conversion in progress.
6. Converted files appear in `output/`, next to the app. The **Open folder**
   button takes you straight there.

Keep the console window open while converting; closing it quits the app.

Nothing needs to be installed beforehand — no Node.js, no ffmpeg, no admin
rights. The only requirement is an internet connection for that first install
step.

### First run warnings

Neither build is signed with a paid developer certificate, so each system shows
a warning the first time:

- **Windows** — "Windows protected your PC". Click *More info* → *Run anyway*.
- **Mac** — "cannot be opened because it is from an unidentified developer".
  Right-click the app and choose *Open*, then confirm. Doing it this way once is
  enough; afterwards it opens normally.

### Folders

Both are created automatically beside the app:

| Folder    | Contents                                        |
| --------- | ----------------------------------------------- |
| `output/` | the converted `*_converted.mp4` files           |
| `bin/`    | the downloaded ffmpeg (created on first install) |

On Mac these sit next to `Video Converter.app`, not inside it.

Sources are never copied, so there is no `input/` folder and no second copy of
a large file eating disk space. If two sources happen to share a name, the
second output becomes `name_converted (2).mp4` rather than overwriting the
first.

### How files are located

Browsers deliberately hide where a file lives: a picked or dropped file exposes
its name but never its path. That is a security boundary, not a setting, and an
earlier attempt to work around it by opening a native dialog meant spawning
PowerShell — which antivirus blocked, and rightly so.

Instead the app searches for the chosen names in the places videos actually
live: the user's Videos, Movies, Desktop, Downloads, Documents and Pictures
folders, plus local drive roots, two levels deep. System and application
folders are skipped. In practice this resolves everything in well under a
second.

If a file is somewhere unusual the app says so and asks for the folder — either
pasted as a path, or chosen with a folder picker. Only the originally selected
files are queued, never everything else in that folder.

## What the conversion does

Profile `smart-cut-h264-aac-cq28-gop30-v1`, matching the shell scripts:

- H.264, Main profile, `yuv420p`, quality 28, capped at 5 Mbit/s
- a keyframe every 30 frames, no scene-cut keyframes, closed GOP
- AAC audio, 160 kbit/s, 48 kHz, stereo
- `+faststart` so playback can begin before the file is fully loaded
- tagged `smart_cut_profile=...` so `smart-cut` recognises it and skips
  re-converting

Every output is checked against its source duration afterwards; a file that
drifts by more than 0.25 s is treated as failed and deleted rather than left in
`output/` looking finished.

### Encoder selection

The app tries `h264_videotoolbox` (Mac), `h264_nvenc`, `h264_qsv`, `h264_amf`
and finally `libx264`, and runs a real one-second test encode on each before
committing to it.

This differs from the shell scripts on purpose. They pick the first encoder that
appears in `ffmpeg -encoders`, but that list reports what ffmpeg was *compiled*
with, not what the machine can actually run. On a PC with an Intel GPU, an
ffmpeg build with NVIDIA support compiled in still advertises `h264_nvenc` and
then fails at runtime with `Cannot load nvcuda.dll`. Since this app is meant to
run on machines nobody has checked in advance, it verifies instead of assuming.

> On the development machine this is not hypothetical: the scripts select
> `h264_nvenc` and fail, while the app correctly falls through to `h264_qsv`.

### Windows and Mac output are not byte-identical

Both platforms produce the same *profile* — the codecs, resolution, pixel
format, audio settings, GOP length and metadata tag all match, and `smart-cut`
treats the two identically. The compressed bytes differ, because the encoding is
done by different hardware: Intel Quick Sync or NVENC on Windows, Apple
VideoToolbox on Mac. Two different silicon encoders aiming at the same quality
target do not produce identical bitstreams.

Making them byte-identical would mean forcing `libx264` everywhere, giving up
hardware acceleration and making large files far slower to convert on both
platforms. Matching the profile is what actually matters downstream, so that is
what the app guarantees.

## For the person building it

Requires Node.js 20 or newer (only to build; the result needs nothing).

```
cd converter-app
npm run build
```

On Windows that produces `dist/VideoConverter.exe`, about 81 MB, which is the
single file to distribute. On Mac it produces `dist/Video Converter.app` —
distribute the whole `.app` folder, zipped if you are sending it somewhere.

**Each platform must be built on that platform.** The build embeds a copy of the
Node binary it is running under, so a Windows machine cannot produce the Mac app
or vice versa.

### Building a Mac app that runs on every Mac

The build embeds the Node binary it runs under, and that binary has an
architecture. Building on an Apple Silicon Mac therefore yields an arm64 app,
which will **not** launch on an Intel Mac at all. The reverse is safe: an x64 app
runs everywhere, on Apple Silicon through Rosetta 2.

`npm run build` warns when it produces an architecture-specific Mac app and tells
you which of these to do:

- **Best — a universal app that runs natively on both.** Needs both Node builds
  present; the build merges them with `lipo`:

  ```
  npm run build -- --universal
  ```

- **Simplest — build on an Intel Mac**, or with an x64 Node under Rosetta:

  ```
  arch -x86_64 npm run build
  ```

Whichever you pick, the ffmpeg downloaded on first run is chosen at runtime to
match the machine, so an Apple Silicon user still gets the native arm64 ffmpeg
and full hardware encoding.

To run from source without packaging:

```
npm start
```

In that mode `input/` and `output/` are the ones in the project root, not beside
the exe.

### How the packaging works

`build.js` inlines the local modules into one script, then uses Node's
single-executable-application support to append that script — plus the `public/`
UI files as SEA assets — to a copy of the Node binary. There are no npm
dependencies at runtime, and `postject` is fetched on demand by `npx` during the
build only.

### Layout

| File            | Role                                              |
| --------------- | ------------------------------------------------- |
| `main.js`       | entry point; starts the server, opens the browser |
| `server.js`     | HTTP API and static hosting                       |
| `convert.js`    | ffmpeg invocation and progress parsing            |
| `ffmpeg.js`     | locating and installing ffmpeg                    |
| `picker.js`     | the native file dialog, per platform              |
| `public/`       | the UI                                            |
| `build.js`      | produces `dist/VideoConverter.exe`                |

### Notes

- The server binds to `127.0.0.1` on a port the OS picks, so it is not reachable
  from the network and never collides with something already listening.
- Uploads are streamed to a `.part` file and renamed only once complete, so an
- Sources are read in place and never copied, so an interrupted run cannot
  leave a half-written file anywhere. A failed conversion deletes its own
  partial output rather than leaving it in `output/` looking finished.
- ffmpeg comes from BtbN's builds, which are the ones ffmpeg.org points at.
  They are served from GitHub releases at full speed and include libx264, AAC
  and every hardware encoder the profile can use.
- Nothing is ever written to a temp folder and executed. An earlier version
  generated a PowerShell script to show a file dialog, which antivirus quite
  reasonably treated as malware; file selection is now pure browser code.
- Files are converted one at a time. Running several encodes at once makes them
  all slower without finishing any sooner.
