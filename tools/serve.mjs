// Minimal static dev server: no host/origin allowlists so it works behind
// reverse-proxy previews (e.g. https://<port>-<sandbox>.e2b.app).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `--site` previews the built static site (dist/site) instead of the dev tree.
// Done with a flag rather than an env-var prefix so it works on Windows too.
const SITE_MODE = process.argv.includes('--site');
const ROOT = process.env.SERVE_DIR
  ? path.resolve(process.env.SERVE_DIR)
  : SITE_MODE
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'site')
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || (SITE_MODE ? 8080 : 5173));
const HOST = process.env.HOST || '0.0.0.0';

// Files that live in src/pwa/ but must be served from the site root, because a
// manifest and a service worker are only found at their declared URL (the
// worker's scope is its own directory, so it has to sit at the root). The site
// build copies them there; the dev server maps them instead of duplicating them
// in the repo, so there is one source of truth in both modes.
const VIRTUAL = {
  '/manifest.webmanifest': 'src/pwa/manifest.webmanifest',
  '/sw.js': 'src/pwa/sw.js',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  const virtual = SITE_MODE ? null : VIRTUAL[urlPath];
  const filePath = path.resolve(ROOT, '.' + (virtual ? '/' + virtual : urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 Not found: ' + urlPath);
      return;
    }
    const headers = {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    };
    // Scope the worker to the whole site. Without this the browser limits it to
    // the script's directory (and refuses a wider scope), which in dev would
    // stop it from ever controlling the game page.
    if (urlPath === '/sw.js') headers['service-worker-allowed'] = '/';
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[sifir-nokta] ${SITE_MODE ? 'site preview' : 'dev server'} listening on http://${HOST}:${PORT}`);
});
