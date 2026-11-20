// 生产环境静态服务器 + API 代理
// 用法: node start-prod.js [端口]
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

/* ─── Web Push (VAPID) — system notifications even when the page is closed ── */
const VAPID_PUBLIC = 'BMYs14LcP59uIkDqvmS0bVWuW6nA9OZsYt81Ks-LOdw4XpxcaMTqFQe94zF5cze6KfI2kFvWpZ5axCEd7V1NI1c';
const VAPID_PRIVATE = 'CIFUJjiTtC_RVvdNfgwonYPh7GQYeSP7wCj_EPsChdM';
webpush.setVapidDetails('mailto:aba@example.com', VAPID_PUBLIC, VAPID_PRIVATE);
const pushSubs = new Map(); // accountDigits -> PushSubscription JSON

const PORT = Number(process.env.PORT || process.argv[2] || 8080);
const ROOT = path.join(__dirname, 'dist', 'public');
// 后端上游：默认本机 5200；拆分服务时可用 API_UPSTREAM_HOST / API_UPSTREAM_PORT 覆盖
const UPSTREAM = {
  host: process.env.API_UPSTREAM_HOST || '127.0.0.1',
  port: Number(process.env.API_UPSTREAM_PORT || 5200),
};

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
  // 后端不可达/卡死时快速失败，由前端走本地兜底；避免 Render 边缘层 502 整站不可用
  proxyReq.setTimeout(15000, () => {
    proxyReq.destroy(new Error('gateway timeout'));
  });
  proxyReq.on('error', () => {
    if (res.headersSent) return;
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'gateway offline' }));
  });
  // 客户端断开时清理上游连接（注意：不能监听 req 的 close，请求体发完即触发会误杀）
  res.on('close', () => { if (!res.writableEnded) proxyReq.destroy(); });
  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);

  // Health check (Render)
  if (p === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, service: 'abac-wallet', ts: Date.now() }));
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
  // Web Push: expose VAPID public key (for frontend subscription)
  if (p === '/api/push/vapid-key') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ key: VAPID_PUBLIC }));
  }
  // Web Push: subscribe — store push subscription by account (digits only)
  if (p === '/api/push/subscribe' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      try {
        const { account, subscription } = JSON.parse(body);
        const digits = String(account || '').replace(/\D/g, '');
        if (digits && subscription) pushSubs.set(digits, subscription);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, account: digits, subs: pushSubs.size }));
      } catch {
        res.writeHead(400); res.end('bad json');
      }
    });
    return;
  }
  // Web Push: send — called after a successful transfer to notify the payee
  if (p === '/api/push/send' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', async () => {
      try {
        const { payeeAccount, title, body: msgBody, amount, currency, fromName } = JSON.parse(body);
        const digits = String(payeeAccount || '').replace(/\D/g, '');
        const sub = pushSubs.get(digits);
        if (!sub) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, reason: 'no subscription for this account' }));
        }
        const payload = JSON.stringify({
          title: title || 'បានទទួលប្រាក់',
          body: msgBody || `${fromName || 'អ្នកផ្ញើ'} បានផ្ញើ ${amount || ''} ${currency || ''} ឲ្យអ្នក`,
          tag: 'aba-transfer-' + Date.now(),
          url: '/notifications',
        });
        try {
          await webpush.sendNotification(sub, payload);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) pushSubs.delete(digits); // expired
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reason: String(e.message || e).slice(0, 80) }));
        }
      } catch {
        res.writeHead(400); res.end('bad json');
      }
    });
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
