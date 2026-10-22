// ✂ Premiere editing extras: typed timecodes, Sync Lock and groups (public/js/model.js).
import { test, assert, eq } from './harness.mjs';
import { parseTC, syncShift, groupedIds } from '../public/js/model.js';

test('typed timecodes: HH:MM:SS:FF, digits from the right, seconds, + / -', () => {
  eq(parseTC('00:01:10:12', 25), { sec: 70.48, rel: 0 });
  eq(parseTC('1012', 25), { sec: 10.48, rel: 0 }, 'digits = HHMMSSFF from the right');
  eq(parseTC('300', 30), { sec: 3, rel: 0 });
  eq(parseTC('+15', 30), { sec: 0.5, rel: 1 }, '+15 = 15 frames later');
  eq(parseTC('-1:00', 30), { sec: 1, rel: -1 });
  eq(parseTC('2.5', 30), { sec: 2.5, rel: 0 });
  eq(parseTC('1;10', 25), { sec: 1.4, rel: 0 });
  for (const bad of ['', 'abc', '1:2:3:4:5', '123456789', ':']) eq(parseTC(bad, 30), null, `"${bad}"`);
});

test('Sync Lock: only sync-locked, unlocked tracks move, from the ripple point on; a V1 picture\'s sound is left to it', () => {
  const p = { tracks: { V1: [{ id: 'v', link: 'L' }], V2: [{ id: 'a', start: 1 }, { id: 'b', start: 5 }], V3: [{ id: 'c', start: 5 }], V4: [{ id: 'd', start: 6 }], A1: [{ id: 's', link: 'L', start: 5 }] },
    trackState: { V2: { sync: true }, V3: {}, V4: { sync: true, lock: true }, A1: { sync: true } } };
  eq(syncShift(p, 4, -2), 1);
  eq([p.tracks.V2[0].start, p.tracks.V2[1].start, p.tracks.V3[0].start, p.tracks.V4[0].start, p.tracks.A1[0].start], [1, 3, 5, 6, 5]);
  eq(syncShift(p, 0, 10), 2, 'everything on V2 from 0 on');
  eq(syncShift(p, 0, -100), 2); assert(p.tracks.V2.every((c) => c.start >= 0), 'never before 0');
});

test('groups: one clip brings its whole group', () => {
  const p = { tracks: { V1: [{ id: 'a', grp: 'g' }], V2: [{ id: 'b', grp: 'g' }, { id: 'c' }], A1: [{ id: 'd', grp: 'h' }] } };
  eq([...groupedIds(p, ['b'])].sort(), ['a', 'b']);
  eq([...groupedIds(p, ['c'])], ['c']);
});
