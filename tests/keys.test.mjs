// ⌨ shortcuts: key presses read the same on any keyboard event; the Premiere preset has no key used twice.
import { test, eq as same, assert } from './harness.mjs';
import { keyOf, BUILTIN, COMMANDS, CMD } from '../public/js/keys.js';

const ev = (o) => ({ key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...o });

test('key presses become "Ctrl+Shift+K" style names', () => {
  same(keyOf(ev({ key: 'k', code: 'KeyK', ctrlKey: true })), 'Ctrl+K');
  same(keyOf(ev({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+K');
  same(keyOf(ev({ key: ' ', code: 'Space' })), 'Space');
  same(keyOf(ev({ key: '`', code: 'Backquote', ctrlKey: true })), 'Ctrl+`');
  same(keyOf(ev({ key: '~', code: '', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+`', 'no code (some keyboards / tools): the key decides');
  same(keyOf(ev({ key: 'Delete', code: 'Delete', shiftKey: true })), 'Shift+Delete');
  same(keyOf(ev({ key: 'ArrowLeft', code: 'ArrowLeft' })), 'Left');
  same(keyOf(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })), '', 'a modifier alone is not a shortcut');
  same(keyOf(ev({ key: 'm', code: 'KeyM', altKey: true })), 'Alt+M');
});

test('every preset key belongs to one command only, and only known commands', () => {
  for (const [id, p] of Object.entries(BUILTIN)) {
    const seen = new Map();
    for (const [cmd, keys] of Object.entries(p.map)) {
      assert(CMD[cmd], `${id}: unknown command ${cmd}`);
      for (const k of keys) { assert(!seen.has(k), `${id}: ${k} on both ${seen.get(k)} and ${cmd}`); seen.set(k, cmd); }
    }
  }
});

test('Premiere preset: the well-known keys', () => {
  const m = BUILTIN.premiere.map;
  // (📌 Delete leaves a gap so nothing else moves, Shift+Delete closes up - as in Premiere)
  same([m.addEdit[0], m.razorTool[0], m.snap[0], m.rippleDelete[0], m.clear[0], m.fullscreen[0], m.shortcuts[0]], ['Ctrl+K', 'C', 'N', 'Shift+Delete', 'Delete', 'Ctrl+`', 'Ctrl+Alt+K']);
  same([m.addEdit, m.rollingTool], [['Ctrl+K', 'S'], []]); // (the user: S splits at the playhead, N is snapping)
  assert(COMMANDS.every((c) => c.id in m), 'every command is in the Premiere preset (even if without a key)');
});
