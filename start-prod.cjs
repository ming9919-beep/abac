// 生产环境静态服务器 + API 代理
// 用法: node start-prod.js [端口]
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || process.argv[2] || 8080);
const ROOT = path.join(__dirname, 'dist', 'public');
const UPSTREAM = { host: '127.0.0.1', port: 5200 };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function proxyApi(req, res) {
  const p = new URL(req.url, 'http://x');
  const proxyReq = http.request(
    { host: UPSTREAM.host, port: UPSTREAM.port, path: p.pathname + p.search, method: req.method, headers: req.headers },
    (pRes) => {
      res.writeHead(pRes.statusCode || 502, pRes.headers);
      pRes.pipe(res);
    }
  );
  proxyReq.on('error', () => {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'gateway offline' }));
  });
  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);

  // Health check (Render)
  if (p === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, service: 'aba001', ts: Date.now() }));
  }

  // API 代理
  // TTS proxy: /api/tts?text=...&lang=km|en|zh → Google Translate TTS (MP3, free, no key)
  if (p === '/api/tts') {
    const text = (url.searchParams.get('text') || '').slice(0, 200);
    const lang = (url.searchParams.get('lang') || 'km').toLowerCase();
    const langMap = { km: 'km', en: 'en', zh: 'zh-CN', 'zh-cn': 'zh-CN' };
    const tl = langMap[lang] || 'km';
    if (!text) { res.writeHead(400); return res.end('missing text'); }
    const ttsUrl = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=' + encodeURIComponent(tl) + '&q=' + encodeURIComponent(text);
    const doGet = (u, redirects) => {
      if (redirects > 3) { res.writeHead(502); return res.end('too many redirects'); }
      const r = https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (pRes) => {
        if (pRes.statusCode === 302 || pRes.statusCode === 301) {
          pRes.resume();
          return doGet(pRes.headers.location, redirects + 1);
        }
        res.writeHead(pRes.statusCode || 200, { 'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=86400' });
        pRes.pipe(res);
      });
      r.on('error', () => { res.writeHead(502); res.end('tts upstream error'); });
      r.setTimeout(8000, () => { r.destroy(); if (!res.headersSent) { res.writeHead(504); res.end('tts timeout'); } });
    };
    doGet(ttsUrl, 0);
    return;
  }
  if (p === '/api' || p.startsWith('/api/')) return proxyApi(req, res);

  let rel = p;
  if (rel === '/' || rel === '') rel = '/index.html';

  let file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }

  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');

  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  }

  // SPA fallback
  const idx = path.join(ROOT, 'index.html');
  if (fs.existsSync(idx)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(idx).pipe(res);
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ABA Mobile App running on http://0.0.0.0:${PORT}`);
  console.log(`Static root: ${ROOT}`);
  console.log(`API proxy:  /api -> http://127.0.0.1:5200`);
});
