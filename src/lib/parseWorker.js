const { parentPort, workerData } = require('worker_threads');
const { extractDemo } = require('./demo');
const { extractTrack, packTrack } = require('./track');
const { extractIntegrity } = require('./integrity');
const { loadGeometry } = require('./geometry');

// mode 'track': sample player positions for the 2D replay (needs the demo's core data).
// mode 'integrity': aim and visibility facts for the Integrity tab (needs the core data too).
if (workerData.mode === 'integrity') {
  try {
    const geometry = workerData.geometryDir ? loadGeometry(workerData.geometryDir, workerData.core.map) : null;
    const data = extractIntegrity(workerData.file, workerData.core, { geometry, onProgress: p => parentPort.postMessage({ progress: p }) });
    parentPort.postMessage({ ok: true, data });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err && err.message || err) });
  }
} else if (workerData.mode === 'track') {
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
