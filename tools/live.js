/**
 * npm run live  –  ek command mein release (MIS ke PC par):
 *   1. git pull        2. npm run check
 *   3. clasp push      4. clasp deploy -i <wahi deployment>  (staff ka link same rehta hai)
 *
 * Deployment ID: .deployment-id file (git mein nahi). Pehli baar
 * `clasp deployments` se dhoondhta hai; ek se zyada hon to poochta hai.
 * Kabhi bina -i deploy nahi karta (warna naya link ban jata).
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const ID_FILE = path.join(ROOT, '.deployment-id');

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

function out(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a.trim()); }));
}

/** clasp deployments ki list: [{ id, version, note }] (@HEAD wali chhod kar). */
function listDeployments() {
  return out('clasp deployments').split(/\r?\n/)
    .map(l => l.match(/^-\s+(\S+)\s+@(\S+)(?:\s+-\s+(.*))?/))
    .filter(m => m && m[2] !== 'HEAD')
    .map(m => ({ id: m[1], version: m[2], note: (m[3] || '').trim() }));
}

async function deploymentId() {
  const saved = fs.existsSync(ID_FILE) ? fs.readFileSync(ID_FILE, 'utf8').trim() : '';
  const list = listDeployments();
  if (saved) {
    if (list.some(d => d.id === saved)) {
      return saved;
    }
    console.log(`\n⚠ .deployment-id (${saved}) is not in "clasp deployments" any more.`);
  }
  if (list.length === 0) {
    throw new Error('No web app deployment found. Make the first one in Apps Script (Deploy → New deployment → Web app), then run again.');
  }
  let pick = list[0];
  if (list.length > 1) {
    console.log('\nMore than one deployment found. Which one is the staff link?');
    list.forEach((d, i) => console.log(`  ${i + 1}. ${d.id}  @${d.version}  ${d.note}`));
    const n = Number(await ask(`Type number (1-${list.length}): `));
    if (!(n >= 1 && n <= list.length)) {
      throw new Error('Wrong number – nothing deployed.');
    }
    pick = list[n - 1];
  }
  fs.writeFileSync(ID_FILE, pick.id + '\n');
  console.log(`\nSaved deployment ID in .deployment-id: ${pick.id}`);
  return pick.id;
}

async function main() {
  run('git pull');
  run('npm run check');
  run('clasp push -f');
  const id = await deploymentId();
  const note = out('git log -1 --pretty=%s').trim().replace(/["&|<>^%]/g, ' ').slice(0, 90) || 'update';   // Windows cmd ke special characters hata kar
  run(`clasp deploy -i ${id} -d "${note}"`);
  console.log('\n✅ Live! Staff link is the same – just refresh the app (Ctrl+Shift+R).');
}

main().catch(e => {
  console.error(`\n❌ Stopped: ${e.message}`);
  process.exit(1);
});
