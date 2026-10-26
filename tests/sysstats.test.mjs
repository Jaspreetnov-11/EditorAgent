// 📊 Mazbooti > Performance (engine/sysstats.mjs): nvidia-smi read right, a helper's numbers made safe, the hour kept
// small, and everything added up across the PCs.
import { test, eq as same, assert } from './harness.mjs';
import { parseSmi, cleanLive, point, addPoint, totals, parseDisks, pcHealth, pcLoad, nasHealth, nasLoad } from '../engine/sysstats.mjs';

test('health 0-100 and load: a calm PC, a hot full one, an absent one; the NAS', () => {
  const calm = { live: { cpu: 10, ramUsed: 8000, ramTotal: 32000, gpus: [{ name: 'RTX', util: 40, memUsed: 6000, memTotal: 12000, temp: 50 }], disks: [{ root: 'C:', total: 1000, free: 600 }] } };
  same(pcHealth(calm).score, 100); same(pcLoad(calm.live), 50);
  const hot = { live: { cpu: 95, ramUsed: 31000, ramTotal: 32000, gpus: [{ name: 'RTX', util: 99, temp: 88 }], disks: [{ root: 'D:', total: 1000, free: 30 }] } };
  const h = pcHealth(hot); same(h.score, 15); assert(h.why.length === 3);
  same(pcHealth({ off: true }).score, 50);
  same(nasHealth({ free: 7300, total: 61440, ms: [40, 45, 50], errors: 0, busy: 1, max: 6 }).score, 85); // (12% free)
  same(nasHealth({ free: 30000, total: 60000, ms: [2000], errors: 2, pending: 3 }).score, 0);
  same(nasLoad({ ms: [40], busy: 3, max: 6 }), 50);
  same(nasLoad({ ms: [500], busy: 0, max: 6 }), 100);
});

test("disks: own ones and NAS shares; the NAS counted once over all PCs", () => {
  const d = parseDisks('[{"DeviceID":"C:","DriveType":3,"Size":498216206336,"FreeSpace":141733920768},{"DeviceID":"Z:","DriveType":4,"Size":65970697666560,"FreeSpace":7971459301376}]');
  same(d, [{ root: 'C:', total: 464, free: 132, net: false }, { root: 'Z:', total: 61440, free: 7424, net: true }]);
  same(parseDisks('{"DeviceID":"D:","DriveType":3,"Size":1073741824,"FreeSpace":0}').length, 1);
  same(parseDisks('oops'), []);
  const nas = { root: 'Z:', total: 61440, free: 7424, net: true };
  const t = totals([{ cores: 1, live: { cpu: 0, gpus: [], disks: [{ root: 'C:', total: 464, free: 132 }, nas] } }, { cores: 1, live: { cpu: 0, gpus: [], disks: [{ root: 'D:', total: 1000, free: 900 }, nas] } }]);
  same([t.diskTotal, t.diskFree, t.nasTotal, t.nasFree], [1464, 1032, 61440, 7424]);
});

test('nvidia-smi lines become cards ([N/A] is nothing)', () => {
  const g = parseSmi('NVIDIA GeForce RTX 5070, 63, 12, 40, 5120, 12227, 61, 143.52, 250.00\r\nNVIDIA GeForce RTX 4060, 0, [N/A], [Not Supported], 300, 8188, 38, 9.1, 115.00\r\n');
  same(g.length, 2);
  same(g[0], { name: 'NVIDIA GeForce RTX 5070', util: 63, enc: 12, dec: 40, memUsed: 5120, memTotal: 12227, temp: 61, power: 144, powerMax: 250 });
  same(g[1].enc, null); same(g[1].dec, null); same(g[1].memTotal, 8188);
  same(parseSmi(''), []);
});

test("a helper's numbers are kept in range", () => {
  const s = cleanLive({ cpu: 140, ramUsed: 9000, ramTotal: 65000, gpus: [{ name: 'x'.repeat(99), util: -5, memUsed: 'a', temp: 61 }] });
  same(s.cpu, 100); same(s.gpus[0].util, 0); same(s.gpus[0].memUsed, null); same(s.gpus[0].name.length, 60);
  same(cleanLive('nope'), null);
  same(cleanLive({ gpus: Array(20).fill({}) }).gpus.length, 8);
});

test('the hour: percentages, the busiest card, old points dropped', () => {
  const p = point({ t: 1, cpu: 30, ramUsed: 16384, ramTotal: 65536, gpus: [{ util: 20, memUsed: 1000, memTotal: 8000, power: 50 }, { util: 90, memUsed: 3000, memTotal: 8000, power: 200 }] });
  same(p, { t: 1, cpu: 30, ram: 25, gpu: 90, vram: 25, power: 250 });
  same(point({ t: 1, cpu: 5, ramUsed: 1, ramTotal: 2, gpus: [] }).gpu, null);
  const h = [{ t: Date.now() - 7200e3 }];
  addPoint(h, { t: Date.now(), cpu: 1, ramUsed: 1, ramTotal: 2, gpus: [] });
  same(h.length, 1);
});

test('cores: kept in range, busy ones counted over all PCs', () => {
  same(cleanLive({ cores: [120, -3, 40, 'x'] }).cores, [100, 0, 40, 0]);
  same(cleanLive({}).cores, []);
  const t = totals([{ cores: 4, live: { cpu: 50, cores: [90, 60, 10, 0], gpus: [] } }, { cores: 2, live: { cpu: 25, cores: [50, 0], gpus: [] } }]);
  same([t.busyCores, t.cores], [3, 6]);
});

test('totals over the PCs (CPU weighted by cores, offline PCs left out)', () => {
  const t = totals([
    { cores: 24, live: { cpu: 50, ramUsed: 20000, ramTotal: 32000, gpus: [{ memUsed: 6000, memTotal: 12000, power: 150, temp: 70 }] } },
    { cores: 8, live: { cpu: 10, ramUsed: 8000, ramTotal: 16000, gpus: [] } },
    { cores: 12, live: null },
  ]);
  same(t.pcs, 2); same(t.cores, 32); same(t.cpu, 40); same(t.ramUsed, 28000); same(t.vramTotal, 12000); same(t.power, 150); same(t.hottest, 70); same(t.gpus, 1);
  assert(totals([]).hottest === null);
});
