// Local dev server without the Vercel CLI: static public/ + Hono app, with vercel.json headers.
// Usage: SESSION_SECRET=... GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... node scripts/dev-server.js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { app } from '../lib/app.js';

if (process.env.GM_MOCK === '1') (await import('./mock-github.js')).installMock();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = new URL('../public/', import.meta.url).pathname;
const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
const extraHeaders = Object.fromEntries((vercel.headers?.[0]?.headers || []).map((h) => [h.key, h.value]));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(chunks) : undefined;
    const out = await app.fetch(new Request(url, { method: req.method, headers: req.headers, body }));
    res.statusCode = out.status;
    // Mock mode: short-circuit the GitHub authorize hop so the browser lands on the callback directly.
    if (process.env.GM_MOCK === '1' && url.pathname === '/api/auth/login' && out.status === 302) {
      const loc = new URL(out.headers.get('location'));
      out.headers.set('location', `/api/auth/callback?code=mock&state=${encodeURIComponent(loc.searchParams.get('state') || '')}`);
    }
    out.headers.forEach((v, k) => { if (k !== 'set-cookie') res.setHeader(k, v); });
    const sc = out.headers.getSetCookie?.() || [];
    if (sc.length) res.setHeader('set-cookie', sc);
    res.end(Buffer.from(await out.arrayBuffer()));
    return;
  }
  let file = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const data = await readFile(join(PUBLIC, file));
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
}).listen(PORT, () => process.stdout.write(`dev server on http://localhost:${PORT}\n`));
