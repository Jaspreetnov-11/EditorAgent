// script.mjs - reads an A/V script (Word .docx, PDF, .txt or pasted text) into scenes the agent can edit to:
//   { visual, vo, super, dur }   visual = what to show (used to find footage), vo = what is said,
//                                super = on-screen text (title / lower third), dur = seconds if the script gives one
// Understands: two-column tables (VIDEO | AUDIO, VISUAL | VO, विज़ुअल | ऑडियो - the Limelight A/V format),
// labelled lines ("VISUAL: ..." / "VO: ..." / "SUPER: ..."), and plain paragraphs (each = one VO scene).
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// ---------------- .docx (a zip with word/document.xml) ----------------
function unzipEntry(buf, name) {
  // end of central directory -> central directory -> local header -> data
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Not a .docx file (zip directory missing)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const fname = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (fname === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error(`${name} not found in the file`);
}
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
// paragraph xml -> text (tabs and line breaks kept)
const paraText = (px) => unxml([...px.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br[^>]*\/>/g)]
  .map((m) => (m[1] !== undefined ? m[1] : m[0].startsWith('<w:tab') ? '\t' : '\n')).join('')).trim();
function docxBlocks(buf) {
  const xml = unzipEntry(buf, 'word/document.xml').toString('utf8');
  const body = xml.slice(xml.indexOf('<w:body'));
  const blocks = []; // { type: 'p', text } | { type: 'table', rows: [[cell text]] }
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[0].startsWith('<w:tbl>')) {
      const rows = [...m[0].matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((r) => [...r[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)]
        .map((c) => [...c[0].matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((p) => paraText(p[0])).filter(Boolean).join('\n')));
      blocks.push({ type: 'table', rows });
    } else { const t = paraText(m[0]); if (t) blocks.push({ type: 'p', text: t }); }
  }
  return blocks;
}

// ---------------- PDF (text via pypdf when installed) ----------------
function pdfText(buf, python) {
  const tmp = path.join(os.tmpdir(), `script-${Date.now()}.pdf`);
  fs.writeFileSync(tmp, buf);
  const r = spawnSync(python, ['-c', 'import sys,pypdf;r=pypdf.PdfReader(sys.argv[1]);sys.stdout.buffer.write("\\n\\n".join((p.extract_text() or "") for p in r.pages).encode("utf-8"))', tmp], { encoding: 'utf8', maxBuffer: 64 << 20 });
  fs.rmSync(tmp, { force: true });
  if (r.status !== 0) {
    if (/No module named 'pypdf'/.test(r.stderr)) throw new Error('PDF scripts need pypdf (pip install pypdf). Or open the PDF, copy the text and paste it here.');
    throw new Error(`Could not read the PDF: ${r.stderr.trim().split('\n').pop()}`);
  }
  return r.stdout;
}

// ---------------- understanding ----------------
const VIS_HEAD = /^(video|visuals?|visual description|shots?|picture|scene|विज़ुअल|विजुअल|दृश्य|वीडियो)\b/i;
const AUD_HEAD = /^(audio|vo|voice ?over|narration|script|dialogues?|ऑडियो|वॉइस ?ओवर|आवाज़|संवाद)\b/i;
const LABEL = /^\s*(visuals?|video|shot|vo|v\.o\.?|voice ?over|narrator|audio|super|supers|text on screen|on-?screen text|title|gfx|graphics?|lower ?third|music|bgm|sfx|duration|time|विज़ुअल|विजुअल|वीओ|सुपर|संगीत)\s*[:：\-–]\s*/i;
const DUR = /\(?\s*(\d{1,2}):(\d{2})\s*\)?|\(?\s*(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds|सेकंड)\b\s*\)?/i;

function kindOf(label) {
  const l = label.toLowerCase();
  if (/^(visuals?|video|shot|विज़ुअल|विजुअल)/.test(l)) return 'visual';
  if (/^(vo|v\.o|voice|narrator|audio|वीओ)/.test(l)) return 'vo';
  if (/^(super|text|on|title|gfx|graphic|lower|सुपर)/.test(l)) return 'super';
  if (/^(duration|time)/.test(l)) return 'dur';
  return 'skip'; // music / sfx notes
}
function durOf(s) {
  const m = DUR.exec(s || '');
  if (!m) return null;
  return m[1] !== undefined ? +m[1] * 60 + +m[2] : +m[3];
}
// split a cell / block into visual / vo / super by labels; unlabelled text goes to `dflt`
function split(text, dflt) {
  const out = { visual: [], vo: [], super: [], dur: null };
  let cur = dflt;
  for (const raw of String(text).split(/\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const m = LABEL.exec(line);
    if (m) { cur = kindOf(m[1]); line = line.slice(m[0].length).trim(); }
    if (cur === 'dur') { out.dur = durOf(line) ?? out.dur; cur = dflt; continue; }
    const d = /^\(?\s*(\d{1,2}:\d{2}|\d+(\.\d+)?\s*(s|sec|secs|seconds|सेकंड))\s*\)?$/i.test(line) ? durOf(line) : null;
    if (d !== null) { out.dur = d; continue; }
    if (!line || cur === 'skip') continue;
    out[cur].push(line.replace(/^["“]|["”]$/g, ''));
  }
  return out;
}
const scene = (visual, vo, sup, dur) => ({ visual: visual.join(' ').trim(), vo: vo.join(' ').trim(), super: sup.join(' / ').trim(), dur: dur ?? null });

function fromTable(rows) {
  if (!rows.length) return [];
  const width = Math.max(...rows.map((r) => r.length));
  if (width < 2) return [];
  // find which columns are visual and audio from the header; default: last two columns = visual, audio
  let vi = width - 2, ai = width - 1, start = 0;
  const head = rows[0].map((c) => c.trim());
  const hv = head.findIndex((c) => VIS_HEAD.test(c)), ha = head.findIndex((c) => AUD_HEAD.test(c));
  if (hv >= 0 || ha >= 0) { start = 1; if (hv >= 0) vi = hv; if (ha >= 0) ai = ha; if (hv < 0) vi = ai === 0 ? 1 : 0; if (ha < 0) ai = vi === width - 1 ? vi - 1 : vi + 1; }
  const durCol = head.findIndex((c) => /^(duration|time|dur|timecode|tc|समय)/i.test(c));
  const out = [];
  for (const r of rows.slice(start)) {
    const v = split(r[vi] || '', 'visual'), a = split(r[ai] || '', 'vo');
    const d = (durCol >= 0 ? durOf(r[durCol]) : null) ?? a.dur ?? v.dur;
    const s = scene([...v.visual, ...a.visual], [...a.vo, ...v.vo], [...v.super, ...a.super], d);
    if (s.visual || s.vo || s.super) out.push(s);
  }
  return out;
}

function fromText(text) {
  // a table copied from Word / Excel arrives as tab-separated rows
  const lines = String(text).replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (lines.length >= 2 && lines.filter((l) => l.includes('\t')).length >= lines.length * 0.6) {
    const t = fromTable(lines.map((l) => l.split('\t')));
    if (t.length) return t;
  }
  const blocks = String(text).replace(/\r/g, '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const labelled = LABEL.test(text.split('\n').find((l) => l.trim()) || '') || /\n\s*(vo|visual|super)\s*:/i.test(text);
  const out = [];
  if (labelled) {
    // a new scene starts at each VISUAL label (or SCENE n heading)
    let cur = null;
    for (const line of String(text).replace(/\r/g, '').split('\n')) {
      if (/^\s*(scene|sc\.?|shot)\s*\d+/i.test(line) || /^\s*(visuals?|video|विज़ुअल|विजुअल)\s*[:：\-–]/i.test(line)) { if (cur) out.push(cur); cur = { t: '' }; }
      if (/^\s*(scene|sc\.?)\s*\d+\s*$/i.test(line)) continue;
      cur ||= { t: '' }; cur.t += `${line}\n`;
    }
    if (cur) out.push(cur);
    return out.map((b) => { const s = split(b.t, 'vo'); return scene(s.visual, s.vo, s.super, s.dur); }).filter((s) => s.visual || s.vo || s.super);
  }
  for (const b of blocks) { const s = split(b, 'vo'); out.push(scene(s.visual, s.vo, s.super, s.dur)); }
  return out.filter((s) => s.visual || s.vo || s.super);
}

// buf: file contents (or null with `text`); name: file name (decides the format)
export function parseScript({ buf = null, name = '', text = '', python = 'python' }) {
  const ext = path.extname(name).toLowerCase();
  let scenes = [], title = '';
  if (buf && ext === '.docx') {
    const blocks = docxBlocks(buf);
    const tables = blocks.filter((b) => b.type === 'table' && Math.max(...b.rows.map((r) => r.length)) >= 2);
    if (tables.length) scenes = tables.flatMap((t) => fromTable(t.rows));
    if (!scenes.length) scenes = fromText(blocks.filter((b) => b.type === 'p').map((b) => b.text).join('\n\n'));
    title = blocks.find((b) => b.type === 'p')?.text.split('\n')[0].slice(0, 80) || '';
  } else if (buf && ext === '.pdf') {
    scenes = fromText(pdfText(buf, python));
  } else if (buf && ext === '.doc') {
    throw new Error('Old .doc files cannot be read - open it in Word and "Save as" .docx, or paste the text.');
  } else {
    scenes = fromText(buf ? buf.toString('utf8').replace(/^﻿/, '') : text);
  }
  const warnings = [];
  if (!scenes.length) warnings.push('No scenes found. Use a two-column table (VIDEO | AUDIO) or lines like "VISUAL: …" and "VO: …".');
  if (scenes.length && !scenes.some((s) => s.visual)) warnings.push('No visual descriptions found - shots will be matched to the voice-over words instead.');
  return { title, scenes: scenes.slice(0, 400), warnings };
}
