/**
 * Stage 4 — Dev proxy server.
 *
 * Serves frontend static files AND proxies /v1/* + /health to stage-1.
 * Both frontend and API appear on the same origin (localhost:8080),
 * which eliminates the CORS issue for local development.
 *
 * Zero dependencies. Uses node:http only.
 *
 * Run: node stage-4/proxy-server.mjs
 * Open: http://localhost:8080
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const FRONTEND_DIR = new URL('./frontend/', import.meta.url).pathname;
const API_TARGET = 'http://localhost:3000';
const PORT = 8080;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

async function serveStatic(res, pathname) {
  const file = pathname === '/' ? '/index.html' : pathname;
  const fullPath = join(FRONTEND_DIR, file);
  try {
    const content = await readFile(fullPath);
    const ext = extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

async function proxyApi(req, res) {
  const { default: http } = await import('node:http');
  const target = new URL(req.url, API_TARGET);
  const proxyReq = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'PROXY_ERROR', message: err.message } }));
  });
  req.pipe(proxyReq);
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname.startsWith('/v1/') || pathname === '/health') {
    void proxyApi(req, res);
  } else {
    void serveStatic(res, pathname);
  }
});

server.listen(PORT, () => {
  console.log(`Stage-4 dev server: http://localhost:${PORT}`);
  console.log(`Proxying API to:  ${API_TARGET}`);
});
