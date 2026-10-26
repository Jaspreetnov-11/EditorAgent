// snmp.mjs - a tiny read-only SNMP v2c client (GET and GETBULK walks) for NAS Care's hardware health.
// It only ever sends read requests: SNMP "set" is not in here at all, so this can never change anything on the NAS.
import dgram from 'node:dgram';

const tlv = (type, body) => Buffer.concat([Buffer.from([type]), len(body.length), body]);
function len(n) {
  if (n < 128) return Buffer.from([n]);
  const b = [];
  while (n > 0) { b.unshift(n & 255); n >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
}
function int(n) {
  const b = [];
  do { b.unshift(n & 255); n = Math.floor(n / 256); } while (n > 0);
  if (b[0] & 0x80) b.unshift(0);
  return tlv(0x02, Buffer.from(b));
}
export function encodeOid(oid) {
  const p = oid.split('.').filter(Boolean).map(Number);
  const out = [40 * p[0] + p[1]];
  for (const n of p.slice(2)) {
    const b = [n & 127];
    for (let v = n >>> 7; v > 0; v >>>= 7) b.unshift(0x80 | (v & 127));
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
function decodeOid(b) {
  const p = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 127); if (!(b[i] & 0x80)) { p.push(v); v = 0; } }
  return p.join('.');
}
// one TLV at pos -> { type, body, next }
function read(buf, pos) {
  const type = buf[pos];
  let l = buf[pos + 1], at = pos + 2;
  if (l & 0x80) { const n = l & 127; l = 0; for (let i = 0; i < n; i++) l = l * 256 + buf[at + i]; at += n; }
  return { type, body: buf.subarray(at, at + l), next: at + l };
}
function children(b) { const out = []; for (let p = 0; p < b.length;) { const t = read(b, p); out.push(t); p = t.next; } return out; }
function value(t) {
  switch (t.type) {
    case 0x02: { let v = 0; for (const x of t.body) v = v * 256 + x; return t.body[0] & 0x80 ? v - 2 ** (8 * t.body.length) : v; }
    case 0x04: return t.body.toString('utf8').replace(/\0+$/, '');
    case 0x06: return decodeOid(t.body);
    case 0x40: return [...t.body].join('.');
    case 0x41: case 0x42: case 0x43: case 0x46: { let v = 0; for (const x of t.body) v = v * 256 + x; return v; }
    case 0x80: case 0x81: case 0x82: return undefined;
    default: return null;
  }
}
export function request(pdu, community, id, oids, bulk = 0) {
  const vbs = tlv(0x30, Buffer.concat(oids.map((o) => tlv(0x30, Buffer.concat([encodeOid(o), Buffer.from([0x05, 0])])))));
  const body = Buffer.concat([int(id), int(0), int(bulk), vbs]);
  return tlv(0x30, Buffer.concat([int(1), tlv(0x04, Buffer.from(community)), tlv(pdu, body)]));
}
export function parseResponse(buf) {
  const msg = children(read(buf, 0).body);
  const pdu = children(msg[2].body);
  const err = value(pdu[1]);
  const binds = children(pdu[3].body).map((vb) => { const [o, v] = children(vb.body); return { oid: decodeOid(o.body), value: value(v), end: v.type >= 0x80 }; });
  return { id: value(pdu[0]), error: err, binds };
}

function send(host, packet, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => { s.close(); reject(new Error('no answer from SNMP (is SNMP v2c on in the NAS settings?)')); }, timeoutMs);
    s.on('message', (m) => { clearTimeout(t); s.close(); try { resolve(parseResponse(m)); } catch (e) { reject(e); } });
    s.on('error', (e) => { clearTimeout(t); s.close(); reject(e); });
    s.send(packet, 161, host);
  });
}
let reqId = 1000;
export async function get(host, community, oids, timeoutMs = 3000) {
  const r = await send(host, request(0xa0, community, ++reqId, oids), timeoutMs);
  return Object.fromEntries(r.binds.filter((b) => !b.end).map((b) => [b.oid, b.value]));
}
// every value under a subtree, a few requests at a time (GETBULK, 20 rows each), capped so a big MIB cannot run forever
export async function walk(host, community, root, timeoutMs = 3000, max = 2000) {
  const out = {};
  let at = root;
  while (Object.keys(out).length < max) {
    const r = await send(host, request(0xa5, community, ++reqId, [at], 20), timeoutMs);
    let more = false;
    for (const b of r.binds) {
      if (b.end || !b.oid.startsWith(root + '.')) { more = false; break; }
      out[b.oid] = b.value; at = b.oid; more = true;
    }
    if (!more) break;
  }
  return out;
}

// QNAP NAS-MIB (enterprise 24681): system temperature, CPU, disks with SMART state, volumes, fans
const Q = '1.3.6.1.4.1.24681.1.2';
export async function qnapHealth(host, community) {
  const sys = await get(host, community, ['1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.3.0', '1.3.6.1.2.1.1.1.0']);
  const t = await walk(host, community, Q);
  const col = (table, c) => Object.entries(t).filter(([o]) => o.startsWith(`${Q}.${table}.1.${c}.`)).map(([o, v]) => [o.split('.').pop(), v]);
  const rows = (table, cols) => {
    const by = {};
    for (const [name, c] of Object.entries(cols)) for (const [i, v] of col(table, c)) (by[i] ||= { index: i })[name] = v;
    return Object.values(by);
  };
  return {
    name: sys['1.3.6.1.2.1.1.5.0'] || host,
    descr: sys['1.3.6.1.2.1.1.1.0'] || '',
    uptimeHours: sys['1.3.6.1.2.1.1.3.0'] ? Math.round(sys['1.3.6.1.2.1.1.3.0'] / 360000) : null,
    cpu: t[`${Q}.1.0`] ?? null, cpuTemp: t[`${Q}.5.0`] ?? null, sysTemp: t[`${Q}.6.0`] ?? null,
    totalMem: t[`${Q}.2.0`] ?? null, freeMem: t[`${Q}.3.0`] ?? null,
    disks: rows(11, { descr: 2, temp: 3, status: 4, model: 5, capacity: 6, smart: 7 }),
    volumes: rows(17, { descr: 2, fs: 3, total: 4, free: 5, status: 6 }),
    fans: rows(15, { descr: 2, speed: 3 }),
    found: Object.keys(t).length,
  };
}
