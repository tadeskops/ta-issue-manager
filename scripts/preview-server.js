/**
 * Zero-dependency static file server for ./preview on http://localhost:5173.
 *   node scripts/preview-server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = path.resolve(__dirname, '..', 'preview');
const PORT = 5173;
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg', '.jpeg': 'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon'
};

http.createServer(function (req, res) {
    let url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/' || url === '') url = '/index-preview.html';
    const file = path.join(ROOT, url);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
    fs.stat(file, function (err, st) {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('not found: ' + url); }
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        fs.createReadStream(file).pipe(res);
    });
}).listen(PORT, '127.0.0.1', function () {
    const url = 'http://localhost:' + PORT + '/index-preview.html';
    console.log('Preview server: ' + url);
    console.log('Press Ctrl+C to stop.');
    // Open default browser (Windows).
    exec('cmd /c start "" "' + url + '"');
});
