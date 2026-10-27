// scramble.mjs - 🔒 a scrambled copy of the editor's browser code for a release: every public/js file minified
// (esbuild) and obfuscated (javascript-obfuscator) into <out>, same names, same imports and exports. server.mjs serves
// public/.dist/js to browsers when it is there; the readable public/js stays for the server's own imports.
//   node tools/scramble/scramble.mjs <public/js> <out dir>
// Run by tools/server/deploy.ps1 on the release; the coding PC itself never has a .dist (it edits the readable code).
import { transform } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import fs from 'node:fs';
import path from 'node:path';

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage: node scramble.mjs <public/js> <out dir>'); process.exit(2); }
// light settings: names and strings hidden, no control-flow tricks that would slow the timeline or the monitor
const OBF = {
  compact: true, sourceType: 'module', target: 'browser', identifierNamesGenerator: 'mangled', renameGlobals: false,
  stringArray: true, stringArrayThreshold: 0.5, stringArrayEncoding: ['base64'], stringArrayRotate: true, stringArrayShuffle: true,
  stringArrayWrappersCount: 1, stringArrayCallsTransform: false, splitStrings: false, controlFlowFlattening: false,
  deadCodeInjection: false, selfDefending: false, debugProtection: false, transformObjectKeys: false,
  unicodeEscapeSequence: false, numbersToExpressions: false, simplify: true, log: false,
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(src).filter((f) => f.endsWith('.js'));
let inBytes = 0, outBytes = 0;
const t0 = Date.now();
for (const f of files) {
  const code = fs.readFileSync(path.join(src, f), 'utf8');
  const min = await transform(code, { loader: 'js', format: 'esm', minify: true, legalComments: 'none', target: 'es2022' });
  const obf = JavaScriptObfuscator.obfuscate(min.code, OBF).getObfuscatedCode();
  fs.writeFileSync(path.join(out, f), obf);
  inBytes += code.length; outBytes += obf.length;
}
console.log(`scrambled ${files.length} files (${(inBytes / 1e6).toFixed(1)} MB -> ${(outBytes / 1e6).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
