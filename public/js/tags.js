// 🏷 Tags: free-text labels with a colour (Premiere's labels + keywords) on templates, media and projects.
// A tag's colour comes from its name (the same tag looks the same everywhere).
import { esc } from './ui.js';

// Premiere's label colours
export const PALETTE = ['#9c7bd8', '#5b6fe0', '#1fb5a8', '#c79be8', '#2f9bd8', '#4e9a3c', '#e07a9c', '#f0a030', '#a35bd0', '#3a74e0', '#2aa7a0', '#d24fa0', '#c8a878', '#6cc04a', '#a0703c', '#e8cf3a'];
const hash = (s) => [...s.toLowerCase()].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
export const tagColor = (t) => PALETTE[hash(String(t)) % PALETTE.length];

// the same rules as the server: trimmed, each once (case ignored), at most 20 of up to 32 characters
export const cleanTags = (list) => [...new Map((list || []).map((t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 32)).filter(Boolean).map((t) => [t.toLowerCase(), t])).values()].slice(0, 20);
export const parseTags = (s) => cleanTags(String(s || '').split(/[,;#]/));

export const tagChips = (tags = [], { remove = false } = {}) => (tags || []).map((t) => `<span class="tag-chip" style="--tc:${tagColor(t)}" data-tagname="${esc(t)}">${esc(t)}${remove ? `<b data-untag="${esc(t)}" title="Remove">×</b>` : ''}</span>`).join('');

// ask for the tags (comma separated) -> the new list, or null when cancelled
export async function editTags(tags = []) {
  const s = prompt('Tags, separated by commas (e.g. logo, intro, client: MyGov):', (tags || []).join(', '));
  return s === null ? null : parseTags(s);
}
