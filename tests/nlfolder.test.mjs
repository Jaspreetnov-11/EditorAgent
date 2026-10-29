// 🎬 the project folder's own Premiere / DaVinci hand-off (engine/nlfolder.mjs): XML + launchers, old files swept
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, assert, eq } from './harness.mjs';
import { writeNleFolder, RESOLVE_LUA, NLE_DIR } from '../engine/nlfolder.mjs';
import { newProject } from '../public/js/model.js';

const media = { m1: { id: 'm1', name: 'shot.mp4', path: 'Z:\\Footage\\shot.mp4', duration: 10, width: 1920, height: 1080, fps: 25, hasAudio: true, type: 'video' } };
const project = (name) => { const pj = newProject(name, { fps: 25 }); pj.tracks.V1 = [{ id: 'c1', type: 'video', mediaId: 'm1', in: 1, out: 4 }]; return pj; };

test('writes the XML, the two launchers and the Resolve script; a rename leaves no old XML behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlefolder-'));
  try {
    const r = writeNleFolder({ project: project('Reel A'), media, dir });
    eq(path.basename(r.xml), 'Reel A.xml');
    eq(r.clips, 1);
    const xml = fs.readFileSync(r.xml, 'utf8');
    assert(xml.includes('file://localhost/Z%3a/Footage/shot.mp4'), 'footage linked where it is');
    for (const f of ['Open in Premiere.cmd', 'Open in DaVinci.cmd']) {
      const t = fs.readFileSync(path.join(dir, f), 'utf8');
      assert(t.includes(`%~dp0${NLE_DIR}\\*.xml`) && t.includes('\r\n'), `${f}: finds the XML, CRLF lines`);
    }
    eq(fs.readFileSync(path.join(dir, NLE_DIR, 'Limelight Timeline.lua'), 'utf8'), RESOLVE_LUA);
    writeNleFolder({ project: project('Reel B'), media, dir });
    eq(fs.readdirSync(path.join(dir, NLE_DIR)).filter((f) => f.endsWith('.xml')), ['Reel B.xml']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the Resolve script in Limelight Editor.exe is the same as the one in the project folder', () => {
  const cs = fs.readFileSync(new URL('../engine/browser/Program.cs', import.meta.url), 'utf8');
  const i = cs.indexOf('ResolveScript = @"') + 'ResolveScript = @"'.length, j = cs.indexOf('";', i);
  eq(cs.slice(i, j).replace(/""/g, '"').replace(/\r\n/g, '\n'), RESOLVE_LUA);
});
