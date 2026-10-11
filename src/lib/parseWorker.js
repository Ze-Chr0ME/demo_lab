const { parentPort, workerData } = require('worker_threads');
const { extractDemo } = require('./demo');

try {
  parentPort.postMessage({ ok: true, data: extractDemo(workerData.file) });
} catch (err) {
  // The header usually still reads fine and tells us which map/mode broke the parser.
  let map = null;
  try { map = require('./parser').parseHeader(workerData.file).map_name; } catch {}
  parentPort.postMessage({ ok: false, error: String(err && err.message || err), map });
}
