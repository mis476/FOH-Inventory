/* Syntax check: har server file (src/*.js) + Index.html ka <script>.  node tests/check.js */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const src = path.join(__dirname, '..', 'src');
let bad = 0;

function check(file, label) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`  ✔ ${label}`);
  } catch (e) {
    bad++;
    console.error(`  ✘ ${label}\n${e.stderr}`);
  }
}

const jsFiles = fs.readdirSync(src).filter(f => f.endsWith('.js'));
if (!jsFiles.length) {
  console.error('  ✘ src/ mein koi .js file nahi hai. Pehle "npm run pull" (clasp pull) chalao.');
  process.exit(1);
}
jsFiles.forEach(f => check(path.join(src, f), f));

fs.readdirSync(src).filter(f => f.endsWith('.html')).forEach(f => {
  const html = fs.readFileSync(path.join(src, f), 'utf8');
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  if (!js.trim()) return;
  const tmp = path.join(os.tmpdir(), `foh-${process.pid}-${f}.js`);
  fs.writeFileSync(tmp, js);
  try { check(tmp, `${f} <script>`); } finally { fs.unlinkSync(tmp); }
});

process.exitCode = bad ? 1 : 0;
