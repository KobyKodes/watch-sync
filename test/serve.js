// Serves the test pages on two ports so the player iframe is cross-origin:
//   http://localhost:8080/?u=NAME  parent page (embeds the player)
//   http://127.0.0.1:8081/         player page with the <video>
// Media is rate-limited per viewer (the `u` query parameter) so tests can
// create real buffering. Test control: GET /__ctl?u=NAME&rate=BYTES_PER_SEC
// and &stall=1|0 on either port.
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = { '.html': 'text/html', '.mp4': 'video/mp4' };
const DEFAULT_RATE = 100 * 1024; // about 4x the test episode's bitrate
const CHUNK = 16 * 1024;
const viewers = new Map(); // name -> { rate, stalled }

function viewer(name) {
  if (!viewers.has(name)) viewers.set(name, { rate: DEFAULT_RATE, stalled: false });
  return viewers.get(name);
}

// Streams [start, end] of a file at the viewer's rate, pausing while stalled.
function throttledSend(file, start, end, v, res) {
  const fd = fs.openSync(file, 'r');
  let pos = start;
  let closed = false;
  res.on('close', () => { closed = true; });
  const step = () => {
    if (closed || pos > end) { fs.closeSync(fd); return res.end(); }
    if (v.stalled) return setTimeout(step, 50);
    const len = Math.min(CHUNK, end - pos + 1);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, pos);
    pos += len;
    res.write(buf);
    setTimeout(step, (len / v.rate) * 1000);
  };
  step();
}

function serve(dir, port) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/__ctl') {
      const v = viewer(url.searchParams.get('u') || 'anon');
      if (url.searchParams.has('rate')) v.rate = Number(url.searchParams.get('rate'));
      if (url.searchParams.has('stall')) v.stalled = url.searchParams.get('stall') === '1';
      res.writeHead(200, { 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify(v));
    }
    const file = path.join(dir, decodeURIComponent(url.pathname).replace(/\/$/, '/index.html'));
    if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const { size } = fs.statSync(file);
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    if (type !== 'video/mp4') {
      res.writeHead(200, { 'content-type': type });
      return fs.createReadStream(file).pipe(res);
    }
    const v = viewer(url.searchParams.get('u') || 'anon');
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    // Byte ranges are required for seeking in <video>.
    const start = range ? Number(range[1] || 0) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(range ? 206 : 200, {
      'content-type': type,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    });
    throttledSend(file, start, end, v, res);
  }).listen(port);
}

const servers = [serve(path.join(__dirname, 'site'), 8080), serve(path.join(__dirname, 'player'), 8081)];
if (require.main === module) console.log('Test site: http://localhost:8080/?u=you');
module.exports = {
  control: (name, opts) => Object.assign(viewer(name), opts),
  close: () => servers.forEach((s) => { s.closeAllConnections(); s.close(); }),
};
