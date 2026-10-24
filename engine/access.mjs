// access.mjs - 🔐 whose project it is, and who may see it (Phase 25). The owner (and anyone on the editing computer itself)
// sees every project; an editor or viewer signed in from another PC sees only their own projects and the ones shared with
// them. Whose: the name saved when it was made (project-access.json, server.mjs), else the editor whose own folder on
// the NAS holds it (Z:\Editor Projects\<Name> - see server.mjs userHome), else the owner's.
// Pure functions: server.mjs keeps the record and applies them to every request.
import path from 'node:path';

const low = (s) => String(s || '').trim().toLowerCase();

// the editor whose own folder (under base) a project's place is in: the folder named like them, or starting with their
// name and a space ("Venky Visuals" is venky's). null: not in anyone's folder
export function folderOwner(place, base, users) {
  if (!place || !base) return null;
  const rel = path.relative(path.resolve(base), path.resolve(place));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const top = low(rel.split(/[\\/]/)[0]);
  const exact = users.find((u) => low(u) === top);
  return exact || users.find((u) => top.startsWith(`${low(u)} `)) || null;
}

// whose a project is: { by } from the record, else its folder; null = the owner's (made on this PC, or in no one's folder)
export function projectOwner(rec, place, base, users) {
  if (rec?.by && users.some((u) => low(u) === low(rec.by))) return users.find((u) => low(u) === low(rec.by));
  return folderOwner(place, base, users);
}

// who: { name, role, local }. owner: projectOwner(...). shared: names it is shared with
export function canSee(who, owner, shared = []) {
  if (!who || who.local || who.role === 'owner') return true;
  const me = low(who.name);
  return !!me && (low(owner) === me || shared.some((s) => low(s) === me));
}

// the project a request is about: ?p=, ?proj= (client review notes), or /pm/<project>/… and /pf/<project>/…
export function requestProject(u) {
  const m = /^\/(pm|pf)\/([^/]+)\//.exec(u.pathname);
  if (m) { try { return decodeURIComponent(m[2]); } catch { return null; } }
  return u.searchParams.get('p') || u.searchParams.get('proj') || null;
}
