// 💡 Prompt guide: example prompts (Hinglish and English) that fill the box where people type to the AI - the Assistant,
// Re-edit's "in your words" and the Agent's notes - plus short tips on what makes a good brief and what each Agent option
// does, in plain words. A chip only fills the box (it never sends), so the editor can change a name or a number first.
import { $, $$, h, esc, modal } from './ui.js';

// q: works in the Assistant's Quick mode too (instant, offline). The rest need Claude (it looks at the footage).
export const PROMPTS = [
  ['Sound', [['music dheema karo', 'q'], ['awaaz saaf karo', 'q'], ['voice over badlo', 'q'], ['music badlo, kuch josh wala', ''], ['make the music softer under the speech', '']]],
  ['Shots', [['pehle 5 sec mein CM sahab ka shot', ''], ['3rd shot hata do', 'q'], ['change the third shot, use a happy face', ''], ['opening slow hai, pehle 10 sec tight karo', ''], ['logo wala shot end mein rakho', '']]],
  ['Format & length', [['9:16 reel bana 30 sec ki', ''], ['video 30 sec ki karo', 'q'], ['make a 60 sec reel of this song from the chorus, with lyrics', ''], ['16:9 aur 9:16 dono bana do', '']]],
  ['Colour & look', [['colour warm karo', 'q'], ['cinematic banao', 'q'], ['thoda bright karo', 'q'], ['sab shots ka colour ek jaisa karo', '']]],
  ['Text & titles', [['title "Viksit Bharat" lagao', 'q'], ['subtitles lagao', 'q'], ['end card pe mygov.in likho', ''], ['har naam ka lower third lagao', '']]],
  ['Whole edit', [['pace tez karke dobara edit karo', 'q'], ['sab cuts par dissolve lagao', 'q'], ['story: pehle problem, phir scheme, phir logon ki khushi', ''], ['is reference jaisa same-to-same edit bana do', '']]],
];

export const TIPS = [
  ['Voice-over first', 'With a VO the shots follow what is said - the best briefs start with the VO file.'],
  ['No VO? Give an outline', 'One idea per line, in order ("Problem / Scheme launch / CM sahab / Beneficiaries / Call to action").'],
  ['Names & spellings', 'Write every name, place and scheme the way it must appear (CM sahab\'s name, "Mahtari Vandan Yojana") - subtitles and titles use them.'],
  ['A reference video', 'Liked an edit? Upload it ("Copy a reference" or 📎 in the Assistant) - its cut and style are copied, only your footage is used.'],
  ['Say where and how much', '"pehle 5 sec mein", "3rd shot", "thoda", "bahut" - a place and an amount beat "better".'],
  ['One change per line', 'Several changes are fine; "aur" / "and" between them, or one per line.'],
];

// what each Agent / Re-edit option does, in plain words (for the guide's last part)
export const OPTIONS = [
  ['Format', 'The frame shape: 9:16 for Reels / Shorts, 16:9 for YouTube and films, 1:1 / 4:5 for feed posts.'],
  ['Cut like', 'A style learnt from an edit you liked (shot length, moves, colour). "The agent\'s own way" uses the settings below.'],
  ['Edit style', 'Standard; Teaser (slow open, build, fast climax); Montage (a cut on every beat); Song (beat + lyrics).'],
  ['Pace', 'How long a shot stays: fast ~1.7 s, medium ~2.8 s, slow ~4 s.'],
  ['Length', 'Only used without a voice-over - with a VO the edit is as long as the VO.'],
  ['Clip speed', 'Slow motion (0.5x) or faster (2x) for every shot.'],
  ['Voice-over / VO language', 'The narration the pictures follow; tell it Hindi or English so it hears the words right.'],
  ['Listening accuracy', 'How carefully the VO is heard: Fast, Good, or Best (slow - for unclear or mixed-language VO).'],
  ['Music: best part', 'Uses the strongest part of the track and cuts on its beats.'],
  ['Keep clips\' own sound', 'Leaves some real sound (crowd, ambience) under the music.'],
  ['Story outline', 'The order of ideas when there is no voice-over - one per line.'],
  ['Auto colour / Film look', 'Balances every shot, then one look over the whole edit (Warm Film, Teal & Orange…).'],
  ['Stabilize', 'Steadies shaky handheld shots (the render takes longer).'],
  ['Cinematic finish', 'Film grade, black bars, vignette and grain.'],
  ['Teaser effects / Sound design', 'Light leaks, whips and flashes on the cuts, whooshes and hits - only in teaser / montage styles.'],
  ['Detect LOG', 'Flat-looking camera footage (S-Log, V-Log) gets the right LUT by itself.'],
  ['Subtitles', 'Captions from the voice-over, spelt with your Names & spellings.'],
  ['Transitions', 'Clean cuts, or dissolves between ideas.'],
  ['Title / End card', 'Text on the first shot, and a closing card (e.g. mygov.in).'],
];

// chips that fill `box` (a textarea / input). quickOnly: only the ones the Assistant's Quick mode understands.
export function promptChips(box, { quickOnly = false, groups = null } = {}) {
  const list = PROMPTS.filter(([g]) => !groups || groups.includes(g)).map(([g, ps]) => [g, ps.filter(([, k]) => !quickOnly || k === 'q')]).filter(([, ps]) => ps.length);
  const el = h(`<div class="pg-chips">${list.map(([g, ps]) => `<div class="pg-row"><span class="pg-g">${esc(g)}</span>${ps.map(([p, k]) => `<button type="button" class="chip pg-chip" data-fill="${esc(p)}"${k === 'q' ? '' : ' data-claude'} title="${k === 'q' ? 'Click to put it in the box - works in Quick mode too' : 'Click to put it in the box - Limelight AI does this one'}">${esc(p)}</button>`).join('')}</div>`).join('')}</div>`);
  el.addEventListener('click', (e) => { const c = e.target.closest('[data-fill]'); if (c) fillBox(box(), c.dataset.fill); });
  return el;
}
// a chip's text goes into the box: on its own when the box is empty, else on a new line after what is there
export function fillBox(box, text) {
  if (!box) return;
  const cur = box.value.trim();
  box.value = cur ? `${cur}${box.tagName === 'TEXTAREA' ? '\n' : ' aur '}${text}` : text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus(); box.setSelectionRange?.(box.value.length, box.value.length);
}

// the whole guide in a window: examples (click = into the box, when a box is given), tips, what each option does
export function openPromptGuide({ box = null, quickOnly = false } = {}) {
  const body = h(`<div class="pg">
    <p class="muted small">Type the way you talk - Hindi, Hinglish or English. ${box ? 'Click an example to put it in the box, then change the names or numbers.' : 'These work in the Assistant, Re-edit and the Agent\'s notes.'} <span class="pg-key"><i class="pg-dot"></i> = Limelight AI does it (it looks at the footage)</span></p>
    <h4>Examples</h4><div data-chips></div>
    <h4>A good brief</h4><ul class="pg-tips">${TIPS.map(([t, d]) => `<li><b>${esc(t)}</b> - ${esc(d)}</li>`).join('')}</ul>
    <details class="pg-opts"><summary><b>What each option does</b></summary><dl>${OPTIONS.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join('')}</dl></details>
    <div class="dv-actions"><button data-close>Close</button></div></div>`);
  const dlg = modal('Prompt guide', body, { width: 640 });
  $('[data-chips]', body).append(promptChips(() => box, { quickOnly }));
  if (box) body.addEventListener('click', (e) => { if (e.target.closest('[data-fill]')) dlg.close(); });
  else $$('[data-fill]', body).forEach((b) => { b.title = 'Copy'; b.onclick = () => { navigator.clipboard?.writeText(b.dataset.fill).catch(() => {}); b.classList.add('on'); }; });
  return dlg;
}

// a small "Ideas" line under a box: a few chips and "More…" (the full guide)
export function ideasLine(box, { picks, quickOnly = false } = {}) {
  const all = PROMPTS.flatMap(([, ps]) => ps), use = picks.map((p) => all.find(([x]) => x === p) || [p, '']);
  const el = h(`<div class="pg-line"><span class="pg-g">Try</span>${use.map(([p, k]) => `<button type="button" class="chip pg-chip" data-fill="${esc(p)}"${k === 'q' ? '' : ' data-claude'}>${esc(p)}</button>`).join('')}<button type="button" class="link small" data-guide>More ideas & tips…</button></div>`);
  el.addEventListener('click', (e) => {
    const c = e.target.closest('[data-fill]'); if (c) fillBox(box(), c.dataset.fill);
    if (e.target.closest('[data-guide]')) openPromptGuide({ box: box(), quickOnly });
  });
  return el;
}
