#!/usr/bin/env node
// Zion compliance gate. Zero dependencies; the same file lives in every Zion
// repo and runs in CI, so a change that breaks the law fails the build instead
// of reaching a visitor. Canonical copy: BarberShopSystem/scripts. Spec:
// docs/COMPLIANCE.md.
//
//   node scripts/compliance-check.mjs [rootDir]
//
// Exceptions go in compliance.allow.json as
//   [{ "rule": "third-party-asset", "path": "src/index.js", "reason": "..." }]
// and a reason is mandatory: an exception nobody can explain is a bug.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.git', 'coverage', '.turbo', 'out', 'vendor', '.dart_tool', 'ios', 'android', '.claude', 'graphify-out', '.vercel', '.cache']);
const CODE_EXT = /\.(m?[jt]sx?|html?|css|vue|svelte|dart)$/i;
const SELF = 'compliance-check.mjs';

// Visitor IP leaves for a server we do not control: Munich court, 100 EUR per
// visitor (Google Fonts); LGPD art. 7 and 33 say the same in Brazil.
const THIRD_PARTY_HOSTS = [
  'fonts.googleapis.com', 'fonts.gstatic.com', 'ajax.googleapis.com', 'maps.googleapis.com',
  'www.gravatar.com', 'secure.gravatar.com', 'www.youtube.com/embed', 'player.vimeo.com',
  'www.google.com/recaptcha', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
  'use.fontawesome.com', 'kit.fontawesome.com', 'use.typekit.net',
];
// Records keystrokes and clicks: wiretapping under California CIPA, 5,000 USD per session.
const SESSION_REPLAY = [
  'hotjar', 'clarity.ms', 'fullstory', 'logrocket', 'mouseflow', 'smartlook', 'rrweb',
  'replayIntegration', 'Sentry.Replay', 'session_recording', 'sessionReplay', 'luckyorange', 'inspectlet',
];
const MAIL_LIBS = /(nodemailer|@sendgrid\/mail|resend|aws-sdk\/client-ses|mailgun|postmark)/;
const BIRTH = /(birthdate|birth_date|data_nascimento|nascimento|dateOfBirth|date_of_birth|\bdob\b|date of birth|fecha de nacimiento)/i;
const SIGNUP_PATH = /(register|signup|sign-up|cadastr|criar-conta|create-account|join)/i;

const BOUND = String.fromCharCode(92) + "b";
const toPosix = (p) => p.split(path.sep).join("/");
const allow = (() => {
  const f = path.join(root, 'compliance.allow.json');
  if (!fs.existsSync(f)) return [];
  const list = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const a of list) if (!a.reason || String(a.reason).trim().length < 10) {
    console.error(`compliance.allow.json: entry for ${a.rule}/${a.path} has no real reason`);
    process.exit(2);
  }
  return list;
})();
// A reason starting with DEBT is a known, dated gap: it keeps CI green but is
// printed on every run so it cannot be forgotten. Anything else is a decision.
const debtSeen = new Set();
const allowed = (rule, rel) => {
  const hit = allow.find((a) => a.rule === rule && toPosix(rel).startsWith(a.path));
  if (hit && /^DEBT/.test(hit.reason)) debtSeen.add(`${rule} ${hit.path || '(repo)'} :: ${hit.reason}`);
  return Boolean(hit);
};

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name)); }
    else yield path.join(dir, e.name);
  }
}

const fails = [];
const warns = [];
const rel = (f) => toPosix(path.relative(root, f));
let sawWeb = false; let sawPrivacy = false; let sawTerms = false; let usesMail = false; let hasUnsub = false;

for (const file of walk(root)) {
  const r = rel(file);
  if (/(^|\/)(tests?|__tests__|docs)\//.test(r) || r.endsWith(SELF) || r.startsWith('scripts/')) continue;
  if (/(privacidade|privacy|politica)/i.test(r)) sawPrivacy = true;
  if (/(termos|terms|tos)/i.test(r)) sawTerms = true;
  if (!CODE_EXT.test(file) && !/package\.json$/.test(file)) continue;
  if (fs.statSync(file).size > 1.5e6) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (/from ['"]next|createRoot|from ['"]react-dom/.test(text)) sawWeb = true;

  for (const host of THIRD_PARTY_HOSTS) {
    if (text.includes(host) && !allowed('third-party-asset', r)) {
      fails.push(`[third-party-asset] ${r} loads ${host}. Self-host it (next/font/local, copy the file) or add a reasoned entry to compliance.allow.json.`);
    }
  }
  for (const word of SESSION_REPLAY) {
    const hit = word.includes('.') || word.includes('_') ? text.includes(word) : new RegExp(BOUND + word + BOUND, 'i').test(text);
    if (hit && !allowed('session-replay', r)) {
      fails.push(`[session-replay] ${r} references "${word}". Session recording needs prior consent and is off by default.`);
    }
  }
  // A page that creates an account must ask for a birthdate on that same page,
  // or the server must (we read the server too, but an account form with no
  // age field is the visible half of the same bug).
  // Detected by route name: every login page also says "register" somewhere.
  if (SIGNUP_PATH.test(r) && /\.(tsx|jsx|html|vue|svelte)$/.test(file) && /type=["']password["']/.test(text)
      && /type=["']email["']|name=["']email["']|setEmail|autoComplete=["']email/.test(text)
      && !BIRTH.test(text) && !allowed('signup-birthdate', r)) {
    fails.push(`[signup-birthdate] ${r} looks like an account creation form with no birthdate or age field.`);
  }
  if (MAIL_LIBS.test(text) && /\.(m?js|ts)$/.test(file)) usesMail = true;
  if (/List-Unsubscribe/i.test(text)) hasUnsub = true;
}

if (sawWeb && !sawPrivacy && !allowed('privacy-page', '')) fails.push('[privacy-page] a web UI with no privacy policy route (privacidade, privacy). LGPD art. 9 / GDPR art. 13.');
if (sawWeb && !sawTerms && !allowed('terms-page', '')) fails.push('[terms-page] a web UI with no terms route (termos, terms).');
if (usesMail && !hasUnsub && !allowed('email-unsubscribe', '')) warns.push('[email-unsubscribe] this repo sends email but never sets List-Unsubscribe (Gmail and Yahoo bulk sender rules, CAN-SPAM).');

// --baseline writes today's failures as dated DEBT exceptions, so a repo can
// adopt the gate green and still see (and burn down) what is owed.
if (process.argv.includes('--baseline')) {
  const day = new Date().toISOString().slice(0, 10);
  const items = fails.map((f) => {
    const m = /^\[([a-z-]+)\] (\S+)/.exec(f);
    const repoLevel = ['privacy-page', 'terms-page'].includes(m[1]);
    return { rule: m[1], path: repoLevel ? '' : m[2], reason: `DEBT ${day}: ${f.replace(/^\[[a-z-]+\] \S+ ?/, '').slice(0, 160)}` };
  });
  fs.writeFileSync(path.join(root, 'compliance.allow.json'), JSON.stringify([...allow, ...items], null, 2) + '\n');
  console.log(`baseline: ${items.length} debt entr${items.length === 1 ? 'y' : 'ies'} written`);
  process.exit(0);
}

for (const d of debtSeen) console.warn(`DEBT  ${d}`);
for (const w of warns) console.warn(`WARN  ${w}`);
for (const f of fails) console.error(`FAIL  ${f}`);
console.log(`compliance: ${fails.length} failure(s), ${warns.length} warning(s) in ${root}`);
process.exit(fails.length ? 1 : 0);
