#!/usr/bin/env node
/**
 * Zero-dependency static file server for the DSH Pad download page.
 *
 * Serves ./web over the LAN and the Tailscale interface so a phone can fetch the APK
 * straight from its browser — no adb, no file manager, no cable.
 *
 *   node serve-apk.js [port]
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, 'web');
const PORT = Number(process.argv[2] || process.env.PORT || 8899);
const HOST = '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  // The MIME that makes Android's browser hand the file to the package installer.
  '.apk': 'application/vnd.android.package-archive',
};

function resolveSafe(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = decoded === '/' ? '/index.html' : decoded;
  const abs = path.join(ROOT, path.normalize(rel));
  return abs.startsWith(ROOT) ? abs : null;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('method not allowed\n');
  }

  const file = resolveSafe(req.url || '/');
  if (file === null) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('forbidden\n');
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('not found\n');
    }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-store',
      'accept-ranges': 'bytes',
    };
    if (ext === '.apk') {
      // Derive the download name from the request — hardcoding one app's filename
      // would save every other APK under the wrong name.
      headers['content-disposition'] = `attachment; filename="${path.basename(file)}"`;
    }

    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`DSH Pad download page serving ${ROOT}`);
  console.log(`  listening on http://${HOST}:${PORT}/`);
  console.log('  stop with Ctrl+C');
});
