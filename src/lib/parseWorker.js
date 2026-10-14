const { parentPort, workerData } = require('worker_threads');
const { extractDemo } = require('./demo');
const { extractRounds } = require('./rounds');
const { extractTrack, packTrack, flightsHelper } = require('./track');
const { extractIntegrity, tickHelper } = require('./integrity');
const { loadGeometry } = require('./geometry');

// mode 'track': sample player positions for the 2D replay (needs the demo's core data).
// mode 'integrity': aim and visibility facts for the Integrity and Aim tabs (needs the core data too).
// mode 'rounds': money, loadouts and callouts per round (for demos read before that existed).
// mode 'ticks': helper of 'integrity', reads part of the ticks into shared memory (see integrity.js).
// mode 'flights': helper of 'track', reads the grenade flights (see track.js).
// default: everything the app reads from every demo (core, events, rounds).
if (workerData.mode === 'ticks') {
  tickHelper(workerData);
} else if (workerData.mode === 'flights') {
  flightsHelper(workerData);
} else if (workerData.mode === 'integrity') {
  try {
    const geometry = workerData.geometryDir ? loadGeometry(workerData.geometryDir, workerData.core.map) : null;
    const { aim, ...data } = extractIntegrity(workerData.file, workerData.core, { geometry, onProgress: p => parentPort.postMessage({ progress: p }) });
    parentPort.postMessage({ ok: true, data, aim });
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
} else if (workerData.mode === 'rounds') {
  try {
    parentPort.postMessage({ ok: true, data: extractRounds(workerData.file, workerData.core) });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err && err.message || err) });
  }
} else {
  try {
    const data = extractDemo(workerData.file);
    // The round facts are extras: a demo whose money or callouts can't be read still gets its stats.
    try { data.rounds = extractRounds(workerData.file, data.core); } catch {}
    parentPort.postMessage({ ok: true, data });
  } catch (err) {
    // The header usually still reads fine and tells us which map/mode broke the parser.
    let map = null;
    try { map = require('./parser').parseHeader(workerData.file).map_name; } catch {}
    parentPort.postMessage({ ok: false, error: String(err && err.message || err), map });
  }
}
