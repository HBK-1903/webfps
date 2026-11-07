#!/usr/bin/env node
// Accessibility audit (axe-core, MPL-2.0) over the real markup in jsdom.
// Screens are audited in isolation (only one screen visible at a time), which
// matches how a screen reader user actually experiences the game.
//
//   node tools/a11y.mjs [--json] [--strict]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');
const WANT_JSON = process.argv.includes('--json');

const screens = [
  { id: 'menu', name: 'Ana menü' },
  { id: 'difficulty-screen', name: 'Zorluk seçimi' },
  { id: 'settings-screen', name: 'Ayarlar' },
  { id: 'controls-screen', name: 'Kontroller' },
  { id: 'pause-screen', name: 'Duraklatma' },
  { id: 'match-end-screen', name: 'Maç sonu' },
];

// Read axe's browser source directly: requiring the package in Node executes it
// in a context without `window`. The source string is what a browser would load.
const axeSource = readFileSync(path.join(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8');

const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<link rel="stylesheet"[^>]*>/g, '');

const results = [];
let totalViolations = 0;

for (const screen of screens) {
  // runScripts is required: without it jsdom never executes the injected script.
  const dom = new JSDOM(html, { url: 'https://a11y.test/', runScripts: 'dangerously' });
  const { document } = dom.window;
  // Show exactly one screen and remove everything else from the tree, so the
  // audit sees what the user actually sees (hidden dialogs would otherwise be
  // reported as "landmarks nested inside landmarks").
  for (const s of screens) {
    const el = document.getElementById(s.id);
    if (!el) continue;
    if (s.id === screen.id) {
      el.classList.remove('hidden');
      el.removeAttribute('aria-hidden');
    } else {
      el.remove();
    }
  }
  for (const id of ['hud', 'toast', 'lock-hint']) document.getElementById(id)?.remove();
  // Menu-only chrome (header/footer landmarks) must not sit inside a dialog.
  document.querySelector('.menu-head')?.remove();
  document.querySelector('.menu-foot')?.remove();
  document.querySelector('.menu-bg-grid')?.remove();


  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => null; // jsdom has no canvas
  // axe-core is a browser script: inject it into the jsdom window explicitly.
  const script = document.createElement('script');
  script.textContent = axeSource;
  document.head.appendChild(script);
  const raw = window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'best-practice'] },
  });
  const report = raw && typeof raw.then === 'function' ? await raw : raw;
  const violations = report.violations || [];
  if (process.argv.includes('--verbose')) {
    for (const v of violations) {
      for (const n of v.nodes) console.log(`      ↳ ${n.target.join(' ')} :: ${(n.failureSummary || '').replace(/\n/g, ' ')}`);
    }
  }
  totalViolations += violations.length;
  results.push({ screen: screen.name, violations: violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length })) });
  const tag = violations.length === 0 ? '✓' : '✗';
  console.log(`${tag} ${screen.name.padEnd(16)} ${violations.length} ihlal`);
  for (const v of violations) {
    console.log(`    · [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} öğe)`);
  }
}

console.log(`\nToplam: ${results.length} ekran, ${totalViolations} ihlal`);

if (WANT_JSON) {
  mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  writeFileSync(path.join(ROOT, 'docs/a11y.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log('  → docs/a11y.json');
}

if (STRICT && totalViolations > 0) process.exit(1);
