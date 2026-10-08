// Writes VERSION in public/sw.js: a fingerprint of every file of the app shell (SHELL). The installed app opens from
// the copy on the phone and only downloads a new one when sw.js changes, so it must change with any file of the app.
// It also checks that SHELL lists every script and stylesheet the app loads.
//   npm run sw-version            updates VERSION
//   node scripts/sw-version.mjs --check   only checks (CI)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SW = join(PUBLIC, 'sw.js');
const check = process.argv.includes('--check');

const source = readFileSync(SW, 'utf8');
const shell = [...source.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

// Everything index.html loads (scripts and stylesheets) and every module they import.
const needed = new Set();
const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
const pending = [
  ...[...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]),
];
while (pending.length) {
  const path = normalize(pending.pop());
  if (needed.has(path)) continue;
  needed.add(path);
  if (!path.startsWith('js/')) continue;
  const code = readFileSync(join(PUBLIC, path), 'utf8');
  for (const [, spec] of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
    pending.push(relative(PUBLIC, join(PUBLIC, dirname(path), spec)));
  }
}
const missing = [...needed].filter((path) => !shell.includes(path));
if (missing.length) {
  console.error(`Faltan en SHELL de public/sw.js: ${missing.join(', ')}`);
  process.exit(1);
}

// The service worker checks the same fingerprint over the files it downloads (fingerprint() in sw.js).
if (new Set(shell).size !== shell.length) {
  console.error('SHELL de public/sw.js repite archivos');
  process.exit(1);
}
const hash = createHash('sha256');
for (const path of [...shell].sort()) hash.update(`${path}\0`).update(readFileSync(join(PUBLIC, path)));
const version = `lah-${hash.digest('hex').slice(0, 12)}`;
const current = source.match(/const VERSION = '([^']+)';/)[1];

if (current === version) {
  console.log(`VERSION al día: ${version}`);
} else if (check) {
  console.error(`VERSION de public/sw.js no corresponde a los archivos de la app (${current}). Ejecuta: npm run sw-version`);
  process.exit(1);
} else {
  writeFileSync(SW, source.replace(`const VERSION = '${current}';`, `const VERSION = '${version}';`));
  console.log(`VERSION: ${current} → ${version}`);
}
