// Production build: bundles the whole game (Three.js included) into a single
// self-contained HTML file that runs offline by double-clicking it.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const OUT_HTML = path.join(DIST, 'SifirNokta.html');

if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/main.js')],
  bundle: true,
  format: 'iife',
  minify: true,
  target: ['es2020'],
  outfile: path.join(DIST, 'sifir-nokta.min.js'),
  legalComments: 'none',
  logLevel: 'info',
});

let html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const cssFiles = ['src/ui/styles.css', 'node_modules/lil-gui/dist/lil-gui.css'];
const css = cssFiles.map((f) => readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const js = readFileSync(path.join(DIST, 'sifir-nokta.min.js'), 'utf8');

// Inline the stylesheet. Replacement *functions* are mandatory here: the
// minified bundle is full of `$` sequences that String.replace would expand.
html = html.replace(/<link rel="stylesheet" href="\.\/src\/ui\/styles\.css" \/>/, () => `<style>\n${css}\n</style>`);
html = html.replace(/<link rel="stylesheet" href="\.\/node_modules\/lil-gui\/dist\/lil-gui\.css" \/>/, () => '');

// Drop the dev import map and inline the bundle instead of the module entry.
html = html.replace(/\s*<!-- Dev mode[\s\S]*?<\/script>\s*/, () => '\n');
html = html.replace(
  /<script type="module" src="\.\/src\/main\.js"><\/script>/,
  () => `<script>\n${js}\n</script>`,
);
if (html.includes('./src/main.js') || html.includes('importmap')) {
  throw new Error('build failed: dev entry points still referenced');
}

writeFileSync(OUT_HTML, html, 'utf8');

const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(0)} KB`;
console.log(`\n  ✓ ${path.relative(ROOT, OUT_HTML)}  (${kb(html)})`);
console.log(`  ✓ ${path.relative(ROOT, path.join(DIST, 'sifir-nokta.min.js'))}  (${kb(js)})`);
console.log('\n  Offline kurulum: dist/SifirNokta.html dosyasını çift tıkla.');
console.log('  Masaüstü penceresi için: tools/launch-windows.bat (Windows) / tools/launch.sh (Linux/macOS)\n');
