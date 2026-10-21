#!/usr/bin/env node
// Auto-tests for the editor (Phase 18): node tests/run.mjs [filter]
// Runs every tests/*.test.mjs. Fast unit tests by default; `--server` also starts a second editor on a spare port with a
// throwaway project folder and checks the API end to end (tests/server.test.mjs) - the running editor is not touched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tests, setFile, Fail } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), filter = args.find((a) => !a.startsWith('--')) || '';
process.env.VEDIT_TEST_SERVER = args.includes('--server') ? '1' : '';
for (const f of fs.readdirSync(HERE).filter((x) => x.endsWith('.test.mjs')).sort()) {
  setFile(f);
  await import(pathToFileURL(path.join(HERE, f)).href);
}
let pass = 0, fail = 0, skip = 0;
const t0 = performance.now();
for (const t of tests) {
  if (filter && !`${t.file} ${t.name}`.toLowerCase().includes(filter.toLowerCase())) continue;
  const s = performance.now();
  try {
    const r = await t.fn();
    if (r === 'skip') { skip++; console.log(`  -  ${t.file}: ${t.name} (skipped)`); continue; }
    pass++; console.log(`  ✓  ${t.file}: ${t.name} ${((performance.now() - s) / 1000).toFixed(2)}s`);
  } catch (e) {
    fail++; console.log(`  ✗  ${t.file}: ${t.name}\n     ${e instanceof Fail ? e.message : e.stack}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
process.exitCode = fail ? 1 : 0;
