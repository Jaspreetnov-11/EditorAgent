// 🔗 linked [V] + [A] clips: the sound of a camera clip on its own audio track stays with its picture after edits.
import { test, eq as same, assert } from './harness.mjs';
import { newProject, syncLinked, linkAudioOf, linkedIds, relink, placed } from '../public/js/model.js';

const media = { a: { duration: 6, hasAudio: true }, b: { duration: 5, hasAudio: true }, mute: { duration: 4, hasAudio: false } };
function proj() {
  const p = newProject('T');
  p.tracks.V1.push({ id: 'va', type: 'video', mediaId: 'a', in: 0 }, { id: 'vb', type: 'video', mediaId: 'b', in: 1, out: 4 });
  for (const v of p.tracks.V1) linkAudioOf(p, media, v);
  return p;
}
const sound = (p, vid) => { const v = Object.values(p.tracks).flat().find((c) => c.id === vid); return Object.values(p.tracks).flat().find((c) => c.type === 'audio' && c.link === v.link); };

test('linkAudioOf: the sound goes on A1 at the picture, the picture goes silent', () => {
  const p = proj();
  same(p.tracks.A1.map((c) => [c.mediaId, c.start, c.in, c.out]), [['a', 0, 0, undefined], ['b', 6, 1, 4]]);
  assert(p.tracks.V1.every((v) => v.mute && v.link), 'pictures are muted and linked');
});

test('moving / trimming the picture moves the sound; reordering V1 too', () => {
  const p = proj();
  p.tracks.V1.reverse(); syncLinked(p, media);
  same([sound(p, 'vb').start, sound(p, 'va').start], [0, 3]);
  p.tracks.V1[0].out = 3; syncLinked(p, media);
  same([sound(p, 'vb').out, sound(p, 'va').start], [3, 2]);
});

test('trimming the sound (it leads) trims the picture', () => {
  const p = proj(), s = sound(p, 'vb');
  s.in = 2; syncLinked(p, media, s.id);
  same(p.tracks.V1[1].in, 2);
});

test('split picture gets its own sound; deleted picture takes its sound along', () => {
  const p = proj(), a = p.tracks.V1[0];
  p.tracks.V1.splice(1, 0, { ...a, id: 'va2', in: 3 }); a.out = 3; syncLinked(p, media);
  assert(sound(p, 'va2') && sound(p, 'va2').link !== sound(p, 'va').link, 'the copy has its own pair');
  same(sound(p, 'va2').in, 3);
  p.tracks.V1 = p.tracks.V1.filter((c) => c.id !== 'va2'); syncLinked(p, media);
  same(p.tracks.A1.length, 2, 'the orphan sound went');
});

test('a picture whose sound was deleted stays silent; replaced by a soundless video drops the sound', () => {
  const p = proj();
  p.tracks.A1 = p.tracks.A1.filter((c) => c.mediaId !== 'b'); syncLinked(p, media);
  same(p.tracks.A1.length, 1); assert(p.tracks.V1[1].mute, 'still silent');
  p.tracks.V1[0].mediaId = 'mute'; syncLinked(p, media);
  same(p.tracks.A1.length, 0);
});

test('linkedIds adds the partner; relink gives copies their own pair', () => {
  const p = proj(), ids = linkedIds(p, ['va']);
  same(ids.size, 2);
  const copies = JSON.parse(JSON.stringify([p.tracks.V1[0], sound(p, 'va')])), old = copies[0].link;
  relink(copies);
  assert(copies[0].link === copies[1].link && copies[0].link !== old, 'one fresh link for the pair');
});

test('a busy A1 sends the sound to a free track (never the music track)', () => {
  const p = newProject('T');
  p.tracks.A1.push({ id: 'vo', type: 'audio', mediaId: 'b', start: 0 });
  p.tracks.V1.push({ id: 'v', type: 'video', mediaId: 'a', in: 0 });
  const r = linkAudioOf(p, media, p.tracks.V1[0]);
  same(r.track, 'A3');
  same(placed(p, media).A3[0].start, 0);
});
