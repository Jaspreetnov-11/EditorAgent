// 🔒 A free HTTPS certificate (Let's Encrypt) for the office link, e.g. editor.limelightcorp.in.
// The link points at this computer's office IP, so Let's Encrypt cannot reach it from the internet: the proof is a DNS
// TXT record the owner adds at the domain's DNS (GoDaddy), "_acme-challenge.<sub>". Two steps:
//   node engine/ssl.mjs start  [domain]   -> asks Let's Encrypt, prints the TXT record to add
//   node engine/ssl.mjs finish [domain]   -> checks the TXT is live, gets the certificate into ssl/
//   node engine/ssl.mjs status [domain]   -> what is there, and when it runs out
// The certificate is valid 90 days; the editor reminds the owner two weeks before (Team dialog) - then start/finish again.
// The account was made accepting the Let's Encrypt Subscriber Agreement (the owner said yes, 2026-10-21), no email.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import acme from 'acme-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SSL_DIR = path.join(ROOT, 'ssl');
const cfg = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { return {}; } };
const [cmd = 'status', argDomain] = process.argv.slice(2);
const DOMAIN = (argDomain || cfg().team?.domain || '').toLowerCase();
if (!DOMAIN) { console.error('ssl: no domain - pass it, or set team.domain in config.json'); process.exit(1); }
fs.mkdirSync(SSL_DIR, { recursive: true });
const F = (n) => path.join(SSL_DIR, n);
export const certFiles = (d) => ({ key: path.join(SSL_DIR, `${d}.key`), cert: path.join(SSL_DIR, `${d}.crt`) });
const STATE = F(`${DOMAIN}.order.json`);
const recordName = `_acme-challenge.${DOMAIN}`;

async function client() {
  let accountKey;
  if (fs.existsSync(F('account.key'))) accountKey = fs.readFileSync(F('account.key'));
  else { accountKey = await acme.crypto.createPrivateKey(); fs.writeFileSync(F('account.key'), accountKey); }
  const acc = fs.existsSync(F('account.json')) ? JSON.parse(fs.readFileSync(F('account.json'), 'utf8')) : null;
  const c = new acme.Client({ directoryUrl: acme.directory.letsencrypt.production, accountKey, ...(acc?.url ? { accountUrl: acc.url } : {}) });
  if (!acc?.url) {
    await c.createAccount({ termsOfServiceAgreed: true });
    fs.writeFileSync(F('account.json'), JSON.stringify({ url: c.getAccountUrl(), created: new Date().toISOString(), terms: 'Let\'s Encrypt Subscriber Agreement accepted by the owner' }, null, 1));
  }
  return c;
}

async function start() {
  const c = await client();
  const order = await c.createOrder({ identifiers: [{ type: 'dns', value: DOMAIN }] });
  const [authz] = await c.getAuthorizations(order);
  const ch = authz.challenges.find((x) => x.type === 'dns-01');
  if (!ch) throw new Error('Let\'s Encrypt offered no DNS check for this name');
  const value = await c.getChallengeKeyAuthorization(ch);
  fs.writeFileSync(STATE, JSON.stringify({ order, value, at: Date.now() }, null, 1));
  const host = recordName.slice(0, -(DOMAIN.split('.').slice(-2).join('.').length + 1)); // the part before the root domain
  console.log(`Add this DNS record at the domain's DNS (GoDaddy > DNS > Add New Record):\n  Type: TXT\n  Name: ${host}\n  Value: ${value}\n  TTL: 1/2 Hour (or the lowest)\nThen run: node engine/ssl.mjs finish`);
}

// is the TXT record live at the domain's own nameservers (and a public resolver)?
async function txtLive(value) {
  const root = DOMAIN.split('.').slice(-2).join('.');
  const ns = await dns.promises.resolveNs(root).catch(() => []);
  const ips = (await Promise.all(ns.slice(0, 2).map((n) => dns.promises.resolve4(n).catch(() => [])))).flat();
  const ask = async (servers) => { const r = new dns.promises.Resolver(); r.setServers(servers); return (await r.resolveTxt(recordName).catch(() => [])).map((x) => x.join('')); };
  const auth = ips.length ? await ask(ips) : [], pub = await ask(['8.8.8.8', '1.1.1.1']);
  return { auth: auth.includes(value), pub: pub.includes(value), seen: [...new Set([...auth, ...pub])] };
}

async function finish() {
  if (!fs.existsSync(STATE)) throw new Error('Run "node engine/ssl.mjs start" first');
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const live = await txtLive(st.value);
  if (!live.auth && !live.pub) throw new Error(`The TXT record ${recordName} is not visible yet${live.seen.length ? ` (found: ${live.seen.join(', ')})` : ''} - add it, wait a few minutes, then run finish again`);
  const c = await client();
  const order = await c.getOrder(st.order);
  const [authz] = await c.getAuthorizations(order);
  const ch = authz.challenges.find((x) => x.type === 'dns-01');
  if (authz.status !== 'valid') { await c.completeChallenge(ch); await c.waitForValidStatus(ch); }
  const [key, csr] = await acme.crypto.createCsr({ commonName: DOMAIN, altNames: [DOMAIN] });
  const fin = await c.finalizeOrder(order, csr);
  const cert = await c.getCertificate(fin);
  const f = certFiles(DOMAIN);
  fs.writeFileSync(f.key, key); fs.writeFileSync(f.cert, cert);
  fs.rmSync(STATE, { force: true });
  console.log(`Certificate saved for ${DOMAIN}: valid until ${new crypto.X509Certificate(cert).validTo}\nRestart the editor (when nobody is working) to serve https://${DOMAIN}. The TXT record can be deleted now.`);
}

function status() {
  const f = certFiles(DOMAIN);
  if (!fs.existsSync(f.cert)) return console.log(`No certificate yet for ${DOMAIN}${fs.existsSync(STATE) ? ' (started - add the TXT record, then finish)' : ''}`);
  const x = new crypto.X509Certificate(fs.readFileSync(f.cert));
  console.log(`${DOMAIN}: ${x.subject.replace(/\n/g, ' ')}, issued by ${x.issuer.split('\n').find((l) => l.startsWith('O=')) || x.issuer}, valid until ${x.validTo} (${Math.floor((Date.parse(x.validTo) - Date.now()) / 86400000)} days left)`);
}

try {
  if (cmd === 'start') await start(); else if (cmd === 'finish') await finish(); else status();
} catch (e) { console.error(`ssl: ${e.message}`); process.exit(1); }
