#!/usr/bin/env node
// Installs a headless Chromium for tools/visual.mjs, entirely from npm.
//
// Why this exists: this environment has no system browser and can only reach
// registry.npmjs.org / pypi.org. Playwright's normal browser download
// (cdn.playwright.dev) and apt-get both fail there — both were tried. What does
// work is @sparticuz/chromium, which ships the Chromium binary *inside the npm
// tarball* along with the AL2023 shared libraries it needs.
//
// Everything lands in .playwright/ (gitignored): ~200 MB, reproducible here.
//
//   node tools/visual-setup.mjs [--force]

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, '.playwright');
const FORCE = process.argv.includes('--force');
const log = (m) => console.log(`  ${m}`);

function main() {
  const binPath = path.join(VENDOR, 'chromium');
  const libDir = path.join(VENDOR, 'lib');
  if (!FORCE && existsSync(binPath) && existsSync(libDir)) {
    log(`zaten kurulu: ${path.relative(ROOT, binPath)}`);
    log('yeniden kurmak için: node tools/visual-setup.mjs --force');
    return;
  }
  mkdirSync(VENDOR, { recursive: true });

  // Deliberately not in package.json: a browser belongs to a dev environment,
  // not to a game that ships as one HTML file.
  log('npm paketleri kuruluyor (playwright-core, @sparticuz/chromium)...');
  execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund',
    'playwright-core', '@sparticuz/chromium'], { cwd: ROOT, stdio: 'inherit' });

  const pkgDir = path.join(ROOT, 'node_modules', '@sparticuz', 'chromium', 'bin');
  const chromiumBr = path.join(pkgDir, 'chromium.br');
  if (!existsSync(chromiumBr)) throw new Error('@sparticuz/chromium bin/ bulunamadı — npm install başarısız');

  log('chromium çıkarılıyor (~200 MB)...');
  writeFileSync(binPath, brotliDecompressSync(readFileSync(chromiumBr)));
  chmodSync(binPath, 0o755);

  // Without these the binary dies at load: "libnspr4.so: cannot open shared object".
  log('paylaşılan kütüphaneler çıkarılıyor...');
  mkdirSync(libDir, { recursive: true });
  const tarPath = path.join(VENDOR, 'al2023.tar');
  writeFileSync(tarPath, brotliDecompressSync(readFileSync(path.join(pkgDir, 'al2023.tar.br'))));
  execFileSync('tar', ['-xf', tarPath, '-C', VENDOR]);
  rmSync(tarPath, { force: true });

  // Prove it runs; a silent install of a broken browser is worse than failing here.
  log('doğrulanıyor...');
  const version = execFileSync(binPath, ['--version'], {
    env: { ...process.env, LD_LIBRARY_PATH: libDir },
    encoding: 'utf8',
  }).trim();
  log(version);
  console.log(`\n  hazır → ${path.relative(ROOT, VENDOR)}/\n  şimdi: npm run visual\n`);
}

try {
  main();
} catch (err) {
  console.error('\nKurulum başarısız:', err.message, '\n');
  process.exit(1);
}
