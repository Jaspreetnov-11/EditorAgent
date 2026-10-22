// 📈 keyframe interpolation: the browser (evalKeys) and the render (keysExpr -> FFmpeg) draw the same curve,
// old keys (per-segment ease) are unchanged, and Premiere's interpolation menu shapes the keys as expected.
import { test, eq, assert } from './harness.mjs';
import { evalKeys, keysExpr, keysToIp, setKeyIp, keyHandle } from '../public/js/model.js';

// a tiny evaluator for the FFmpeg expressions keysExpr writes (if / lt / + - * / and parentheses)
function ffEval(expr, T) {
  let i = 0;
  const peek = () => expr[i], eat = (c) => { if (expr[i] !== c) throw new Error(`expected ${c} at ${i}: ${expr.slice(i, i + 20)}`); i++; };
  function prim() {
    if (peek() === '(') { eat('('); const v = sum(); eat(')'); return v; }
    if (peek() === '-') { i++; return -prim(); }
    if (expr.startsWith('if(', i)) { i += 3; const c = sum(); eat(','); const a = sum(); eat(','); const b = sum(); eat(')'); return c ? a : b; }
    if (expr.startsWith('lt(', i)) { i += 3; const a = sum(); eat(','); const b = sum(); eat(')'); return a < b ? 1 : 0; }
    if (expr.startsWith('t', i)) { i++; return T; }
    const m = /^\d+(\.\d+)?/.exec(expr.slice(i)); if (!m) throw new Error(`bad token at ${i}: ${expr.slice(i, i + 20)}`);
    i += m[0].length; return +m[0];
  }
  function prod() { let v = prim(); while (peek() === '*' || peek() === '/') { const o = expr[i++], r = prim(); v = o === '*' ? v * r : v / r; } return v; }
  function sum() { let v = prod(); while (peek() === '+' || peek() === '-') { const o = expr[i++], r = prod(); v = o === '+' ? v + r : v - r; } return v; }
  const v = sum(); if (i !== expr.length) throw new Error(`left over: ${expr.slice(i, i + 20)}`);
  return v;
}
const agree = (keys, tol, msg) => {
  const ex = keysExpr(keys, 't'), lo = keys[0].t - 0.5, hi = keys[keys.length - 1].t + 0.5;
  const span = Math.max(1e-3, ...keys.map((k) => Math.abs(k.v - keys[0].v)));
  for (let j = 0; j <= 200; j++) {
    const t = lo + ((hi - lo) * j) / 200, a = evalKeys(keys, t), b = ffEval(ex, t);
    assert(Math.abs(a - b) <= tol * span, `${msg}: at t=${t.toFixed(3)} preview ${a} vs render ${b}`);
  }
  return ex;
};
// keysExpr as it was before per-key interpolation (old projects must render byte for byte the same)
function oldKeysExpr(keys, T = 't') {
  const f = (x) => (+x).toFixed(5);
  if (keys.length === 1) return f(keys[0].v);
  let e = f(keys[keys.length - 1].v);
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i], b = keys[i + 1], d = Math.max(1e-6, b.t - a.t);
    const u = `((${T}-${f(a.t)})/${f(d)})`;
    const s = a.ease === true || a.ease === 'io' ? `(${u}*${u}*(3-2*${u}))` : a.ease === 'in' ? `(${u}*${u})` : a.ease === 'out' ? `(1-(1-${u})*(1-${u}))` : a.ease === 'hold' ? '0' : u;
    e = `if(lt(${T},${f(b.t)}),${f(a.v)}+(${f(b.v - a.v)})*${s},${e})`;
  }
  return `if(lt(${T},${f(keys[0].t)}),${f(keys[0].v)},${e})`;
}
const copy = (x) => JSON.parse(JSON.stringify(x));
const OLD = [{ t: 0, v: 1, ease: 'io' }, { t: 1, v: 1.5, ease: 'in' }, { t: 2.5, v: 0.8, ease: 'out' }, { t: 3, v: 2 }, { t: 4, v: 3, ease: 'hold' }, { t: 5, v: 0 }];

test('old keys: the same expression as before and the same curve', () => {
  eq(agree(OLD, 1e-4, 'old eases'), oldKeysExpr(OLD), 'the render expression of an old project');
  eq(evalKeys(OLD, 0.5), 1 + 0.5 * 0.5, 'smooth (io) half way');
  eq(+evalKeys(OLD, 4.5).toFixed(6), 3, 'hold');
});

test('keysToIp keeps the curve of old eases exactly', () => {
  const k = keysToIp(copy(OLD));
  assert(k.every((x) => x.ip && x.ease === undefined), 'every key has an interpolation');
  for (let t = -0.2; t < 5.4; t += 0.05) assert(Math.abs(evalKeys(k, t) - evalKeys(OLD, t)) < 1e-4, `at ${t}: ${evalKeys(k, t)} vs ${evalKeys(OLD, t)}`);
  agree(k, 1e-4, 'converted');
});

test('every interpolation: preview and render agree', () => {
  for (const mode of ['linear', 'bezier', 'auto', 'cont', 'hold', 'easein', 'easeout', 'easy']) {
    const k = copy(OLD.map(({ t, v }) => ({ t, v })));
    for (let i = 0; i < k.length; i++) setKeyIp(k, i, mode);
    agree(k, 1e-4, mode);
  }
});

test('dragged handles (uneven influence): preview and render within 0.5%, expression stays short', () => {
  const k = [{ t: 0, v: 0, ip: 'bezier', out: { s: 0, f: 0.9 } }, { t: 2, v: 100, ip: 'bezier', in: { s: 0, f: 0.75 }, out: { s: 300, f: 0.05 } }, { t: 3, v: 20, ip: 'cont', in: { s: -40, f: 0.6 }, out: { s: -40, f: 0.2 } }, { t: 4, v: 0, ip: 'linear' }];
  const ex = agree(k, 0.005, 'uneven');
  assert(ex.length < 8000, `expression length ${ex.length}`);
  // the ends are reached exactly and the strong ease starts flat
  eq(+evalKeys(k, 2).toFixed(6), 100); assert(evalKeys(k, 0.2) < 1, 'eases out of the first key');
});

test('Easy Ease / Ease In / Ease Out set the handle speeds Premiere sets', () => {
  const k = [{ t: 0, v: 0 }, { t: 1, v: 10 }, { t: 2, v: 0 }];
  setKeyIp(k, 1, 'easein');
  eq(keyHandle(k, 1, 'in').s, 0); eq(+keyHandle(k, 1, 'out').s.toFixed(3), -10);
  setKeyIp(k, 1, 'easeout'); eq(keyHandle(k, 1, 'out').s, 0);
  setKeyIp(k, 0, 'easy'); eq(keyHandle(k, 0, 'out').s, 0);
  setKeyIp(k, 1, 'auto'); eq(keyHandle(k, 1, 'in').s, 0, 'auto bezier on a peak is flat');
  setKeyIp(k, 1, 'hold'); eq(evalKeys(k, 1.7), 10, 'hold');
  agree(k, 1e-4, 'mixed');
});

test('a plain key added among new ones (e.g. a value typed at the playhead) still agrees', () => {
  const k = [{ t: 0, v: 0, ip: 'auto' }, { t: 1, v: 5 }, { t: 2, v: 1, ip: 'bezier', in: { s: 0, f: 0.5 }, out: { s: 0, f: 1 / 3 } }, { t: 3, v: 4, ease: 'io' }, { t: 4, v: 0 }];
  agree(k, 0.005, 'plain key');
});
