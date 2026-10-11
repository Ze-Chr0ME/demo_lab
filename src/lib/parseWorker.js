const { parentPort, workerData } = require('worker_threads');
const { extractDemo } = require('./demo');
const { extractTrack, packTrack } = require('./track');

// mode 'track': sample player positions for the 2D replay (needs the demo's core data).
if (workerData.mode === 'track') {
  try {
    const buf = packTrack(extractTrack(workerData.file, workerData.core));
    parentPort.postMessage({ ok: true, data: buf });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err && err.message || err) });
  }
} else {
  try {
    parentPort.postMessage({ ok: true, data: extractDemo(workerData.file) });
  } catch (err) {
    // The header usually still reads fine and tells us which map/mode broke the parser.
    let map = null;
    try { map = require('./parser').parseHeader(workerData.file).map_name; } catch {}
    parentPort.postMessage({ ok: false, error: String(err && err.message || err), map });
  }
}
