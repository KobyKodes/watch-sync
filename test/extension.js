// Copies the extension to a temp folder with config.js pointed at the local test
// relay, since the real extension always connects to the hosted one.
const path = require('path');
const os = require('os');
const fs = require('fs');

module.exports = function localExtension(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchsync-ext-'));
  fs.cpSync(path.resolve(__dirname, '../extension'), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.js'), `const WATCH_SYNC_SERVER = 'ws://localhost:${port}';\n`);
  return dir;
};
