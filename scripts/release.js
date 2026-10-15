// Publishes a DemoLab release on GitHub (Ze-Chr0ME/demo_lab), which installed copies pick up as an update.
//   1. raise "version" in package.json (e.g. 1.0.0 → 1.1.0), commit and push it
//   2. npm run release                      (release notes generated from the commits since the last release)
//      npm run release -- notes.md          (release notes from a file)
// Builds the installer with scripts/dist.js and uploads it as the release's only file. Needs the GitHub CLI
// (gh), signed in with write access to the repo.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { REPO } = require('../src/lib/updater');

const root = path.join(__dirname, '..');
const { version } = require('../package.json');
const tag = `v${version}`;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
const fail = msg => { console.error(msg); process.exit(1); };

try { run('gh', ['--version']); } catch { fail('The GitHub CLI (gh) is needed: winget install GitHub.cli, then gh auth login.'); }
let exists = true;
try { run('gh', ['release', 'view', tag, '-R', REPO], { stdio: 'pipe' }); } catch { exists = false; }
if (exists) fail(`Release ${tag} already exists. Raise "version" in package.json first.`);
if (run('git', ['status', '--porcelain']).trim()) fail('Commit your changes first: the release is built from the working tree and tagged on HEAD.');
const head = run('git', ['rev-parse', 'HEAD']).trim();
if (!run('git', ['branch', '-r', '--contains', head]).trim()) fail('Push your commits first: the release tag points at HEAD, which GitHub does not have yet.');

const notes = process.argv[2];
if (notes && !fs.existsSync(notes)) fail(`Release notes file not found: ${notes}`);

run(process.execPath, [path.join(__dirname, 'dist.js')], { stdio: 'inherit' });
const exe = path.join(root, 'dist', `CS2-DemoLab-Setup-${version}.exe`);
if (!fs.existsSync(exe)) fail(`The build did not produce ${exe}`);

run('gh', ['release', 'create', tag, exe, '-R', REPO, '--target', head, '--title', `CS2 DemoLab ${version}`,
  ...(notes ? ['--notes-file', notes] : ['--generate-notes'])], { stdio: 'inherit' });
console.log(`Published ${tag}. Installed copies of DemoLab will download it within 6 hours (or at their next start).`);
