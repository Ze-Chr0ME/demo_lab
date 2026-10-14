// Loads the demo parser. Prefers our own build in vendor/demoparser2 (demoparser master 45ca85a plus
// vendor/demoparser2/rush-fixes.patch, which makes rush_001 demos readable) and falls back to the
// official npm package. DEMOLAB_PARSER=npm forces the npm package (used for regression tests).
const path = require('path');
const fs = require('fs');

const VENDORED = path.join(__dirname, '..', '..', 'vendor', 'demoparser2', 'demoparser2.win32-x64-msvc.node');

function load() {
  if (process.env.DEMOLAB_PARSER !== 'npm' && fs.existsSync(VENDORED)) {
    try { return { parser: require(VENDORED), source: 'vendored' }; } catch {}
  }
  return { parser: require('@laihoe/demoparser2'), source: 'npm' };
}

const { parser, source } = load();
module.exports = parser;
module.exports.source = source;
