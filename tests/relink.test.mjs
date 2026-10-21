// 🔗 auto-relink: the folder a file moved to is learnt from one relink and used for the others (server.mjs learnMove /
// viaMoves). The path logic is checked here on Windows-style paths, without a server.
import { test, eq as same } from './harness.mjs';
import path from 'node:path';

// the same tail-stripping learnMove does (kept in step with server.mjs)
function move(oldPath, newPath) {
  const a = path.win32.resolve(oldPath).split(/[\\/]/), b = path.win32.resolve(newPath).split(/[\\/]/);
  while (a.length > 1 && b.length > 1 && a[a.length - 1].toLowerCase() === b[b.length - 1].toLowerCase()) { a.pop(); b.pop(); }
  return { from: a.join('\\'), to: b.join('\\') };
}

test('a drive letter change is learnt as the drive', () => {
  same(move('Z:\\Agent Bus\\day1\\a.mp4', 'Y:\\Agent Bus\\day1\\a.mp4'), { from: 'Z:', to: 'Y:' });
});
test('a folder moved into an archive is learnt as that folder', () => {
  same(move('D:\\Raw\\CG Tour\\b.mov', 'E:\\Archive\\2026\\Raw\\CG Tour\\b.mov'), { from: 'D:', to: 'E:\\Archive\\2026' });
  same(move('D:\\Shoot\\Day 1\\c.mp4', 'D:\\Shoot 2026\\Day 1\\c.mp4'), { from: 'D:\\Shoot', to: 'D:\\Shoot 2026' });
});
test('the server splits Windows paths on backslashes', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const line = src.split('\n').find((l) => l.includes('path.resolve(oldPath).split('));
  same(line.includes('split(/[\\\\/]/)'), true, 'learnMove splits on \\ and /');
});
