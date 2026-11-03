// A launcher/terminal may close its redirected output while Electron is still running.
// Handle EPIPE on the streams themselves, including writes from Electron's IPC error reporter.
const guarded = new WeakSet();
function guardOutputStream(stream, reportError) {
  if (!stream || guarded.has(stream)) return;
  guarded.add(stream);
  stream.on('error', error => {
    if (error.code === 'EPIPE') return;
    reportError(error);
  });
}
function guardOutputPipes(reportError = error => { throw error; }) {
  guardOutputStream(process.stdout, reportError);
  guardOutputStream(process.stderr, reportError);
}
module.exports = { guardOutputPipes, guardOutputStream };
