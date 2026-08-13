'use strict';

// Entry point. Starts the local server and opens the GUI in the default
// browser, so the user only ever double-clicks one file.

const { spawn } = require('child_process');
const { start, ROOT } = require('./server');

function openBrowser(url) {
  if (process.platform === 'win32') {
    // "start" is a cmd builtin, not an executable. The empty string is the
    // window title -- without it, cmd treats a quoted URL as the title and
    // opens nothing.
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

start()
  .then(({ url }) => {
    console.log('');
    console.log('  Video Converter is running.');
    console.log('');
    console.log('  Folder: ' + ROOT);
    console.log('  Address: ' + url);
    console.log('');
    console.log('  The app should open in your browser automatically.');
    console.log(
      process.platform === 'win32'
        ? '  Keep this window open while converting. Close it to quit.'
        : '  Keep this Terminal window open while converting. Close it to quit.'
    );
    console.log('');
    openBrowser(url);
  })
  .catch((err) => {
    console.error('Failed to start: ' + err.message);
    process.exitCode = 1;
    // Without this the console window vanishes instantly on a double-click and
    // the user never sees why it failed.
    if (process.platform === 'win32' && process.stdin.isTTY) {
      console.error('Press Ctrl+C to close.');
      process.stdin.resume();
    }
  });
