// A tiny test runner (no packages to install): test(name, fn) registers, tests/run.mjs runs every *.test.mjs file.
export const tests = [];
export const test = (name, fn) => tests.push({ name, fn, file: currentFile });
let currentFile = '';
export const setFile = (f) => { currentFile = f; };

export class Fail extends Error {}
export function assert(ok, msg = 'assertion failed') { if (!ok) throw new Fail(msg); }
// the same data, whatever order the object keys were written in
const canon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v));
export function eq(got, want, msg = '') {
  const g = canon(got), w = canon(want);
  if (g !== w) throw new Fail(`${msg ? `${msg}: ` : ''}expected ${w.slice(0, 300)}\n     got ${g.slice(0, 300)}`);
}
// a seeded random source, so a failing case can be run again
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  return { next, int: (n) => Math.floor(next() * n), chance: (p) => next() < p, pick: (a) => a[Math.floor(next() * a.length)] };
}
