// Static site build: what actually gets uploaded to Cloudflare Pages / Netlify /
// GitHub Pages, or served from any plain web server.
//
// The offline artifact (dist/SifirNokta.html) is one self-contained file for
// double-clicking. A *site* is the opposite: a folder with a normal index.html,
// a manifest, a service worker and icons, so the browser can install the game as
// an app and keep it offline through the service worker.
//
// Layout produced:
//   dist/site/index.html            ← inlined CSS + inlined JS, PWA links intact
//   dist/site/manifest.webmanifest
//   dist/site/sw.js
//   dist/site/icons/*.png
//   dist/site/SifirNokta.html       ← the offline single-file copy, servable too
//   dist/site/_headers              ← Cloudflare Pages header rules
//   dist/site/404.html
//
// Run: node tools/build-site.mjs   (or npm run build:site)
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';

const ROOT = path.dirname(fileURLToPath(import.meta.url)).replace(/[\\/]tools$/, '');
const DIST = path.join(ROOT, 'dist');
const SITE = path.join(DIST, 'site');

if (!existsSync(path.join(DIST, 'SifirNokta.html'))) {
  throw new Error('build failed: run `npm run build` first (dist/SifirNokta.html missing)');
}

rmSync(SITE, { recursive: true, force: true });
mkdirSync(SITE, { recursive: true });

// --- JS bundle (kept as its own file here: a site has no reason to inline it
// into the HTML, and a separate file caches better across deploys) ------------
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/main.js')],
  bundle: true,
  format: 'iife',
  minify: true,
  target: ['es2020'],
  outfile: path.join(SITE, 'game.min.js'),
  legalComments: 'none',
  logLevel: 'silent',
});

let html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = ['src/ui/styles.css', 'node_modules/lil-gui/dist/lil-gui.css']
  .map((f) => readFileSync(path.join(ROOT, f), 'utf8'))
  .join('\n');

// Replacement functions are mandatory: the minified bundle is full of `$`
// sequences that String.replace would treat as substitution patterns.
html = html.replace(/<link rel="stylesheet" href="\.\/src\/ui\/styles\.css" \/>/, () => `<style>\n${css}\n</style>`);
html = html.replace(/<link rel="stylesheet" href="\.\/node_modules\/lil-gui\/dist\/lil-gui\.css" \/>/, () => '');

// Drop the dev module entry + import map, load the bundle instead.
html = html.replace(/\s*<!-- Dev mode[\s\S]*?<\/script>\s*/, () => '\n');
html = html.replace(
  /<script type="module" src="\.\/src\/main\.js"><\/script>/,
  () => '<script src="./game.min.js" defer></script>',
);
if (html.includes('./src/main.js') || html.includes('importmap')) {
  throw new Error('build failed: dev entry points still referenced');
}
if (!html.includes('manifest.webmanifest')) {
  throw new Error('build failed: manifest link was lost from index.html');
}

writeFileSync(path.join(SITE, 'index.html'), html, 'utf8');

// --- assets -----------------------------------------------------------------
cpSync(path.join(ROOT, 'src/pwa/manifest.webmanifest'), path.join(SITE, 'manifest.webmanifest'));
cpSync(path.join(ROOT, 'src/pwa/sw.js'), path.join(SITE, 'sw.js'));
cpSync(path.join(ROOT, 'icons'), path.join(SITE, 'icons'), { recursive: true });
cpSync(path.join(DIST, 'SifirNokta.html'), path.join(SITE, 'SifirNokta.html'));

// --- hosting rules ----------------------------------------------------------
// The bundle has no eval() and no inline event handlers, so the CSP can be
// strict. 'unsafe-inline' is only needed for the inlined <style>.
writeFileSync(
  path.join(SITE, '_headers'),
  `/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=()
  Cross-Origin-Opener-Policy: same-origin

# Never cache the entry points, or a deploy takes days to reach players.
/
  Cache-Control: public, max-age=0, must-revalidate
/index.html
  Cache-Control: public, max-age=0, must-revalidate
/sw.js
  Cache-Control: public, max-age=0, must-revalidate
/manifest.webmanifest
  Cache-Control: public, max-age=0, must-revalidate

# Hashed-by-cache-busting assets can be cached for a week.
/icons/*
  Cache-Control: public, max-age=604800
/game.min.js
  Cache-Control: public, max-age=3600
SifirNokta.html
  Cache-Control: public, max-age=3600
`,
  'utf8',
);

// Plain offline page for a stale bookmark / deleted file.
writeFileSync(
  path.join(SITE, '404.html'),
  `<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8" /><title>Sayfa bulunamadı — SIFIR NOKTA</title>
<meta name="theme-color" content="#0b0f12" />
<style>html{background:#0b0f12;color:#dbe7ea;font:16px/1.6 system-ui,sans-serif}
main{max-width:38rem;margin:18vh auto;padding:0 1.5rem}
h1{color:#4fd1c5;letter-spacing:.18em;font-size:1.1rem}
a{color:#4fd1c5}</style></head>
<body><main><h1>SIFIR NOKTA</h1>
<p>Bu adreste bir sayfa yok. Menüye dönüp oyuna başlayabilirsin.</p>
<p><a href="./">← Menüye dön</a></p></main></body></html>
`,
  'utf8',
);

// --- report -----------------------------------------------------------------
const kb = (p) => `${(readFileSync(p).length / 1024).toFixed(0)} KB`;
const files = [
  'index.html', 'game.min.js', 'manifest.webmanifest', 'sw.js',
  'SifirNokta.html', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
];
const total = files.reduce((sum, f) => sum + readFileSync(path.join(SITE, f)).length, 0);
for (const f of files) console.log(`  ✓ dist/site/${f}  (${kb(path.join(SITE, f))})`);
console.log(`\n  Site toplam: ${(total / 1024 / 1024).toFixed(2)} MB → dist/site/`);
console.log('  Yerel önizleme: npm run preview:site');
console.log('  Yayın: dist/site klasörünü Cloudflare Pages / Netlify / GitHub Pages\'e yükle.\n');
