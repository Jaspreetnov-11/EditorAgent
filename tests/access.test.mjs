// 🔐 whose project it is and who may see it (engine/access.mjs): the folder rule, the saved maker, sharing, the owner
import { test, assert, eq } from './harness.mjs';
import { folderOwner, projectOwner, canSee, requestProject } from '../engine/access.mjs';

const users = ['jaspreet', 'venky', 'vishal', 'Guna', 'dev'];
const base = 'Z:\\Editor Projects';

test('🔐 a project in an editor\'s own NAS folder is theirs ("Venky Visuals" is venky\'s); elsewhere it is no one\'s', () => {
  eq(folderOwner('Z:\\Editor Projects\\Venky Visuals\\Teaser', base, users), 'venky');
  eq(folderOwner('Z:\\Editor Projects\\vishal\\Oct\\Reel 2', base, users), 'vishal', 'any depth, any case');
  eq(folderOwner('Z:\\Editor Projects\\Guna\\testing1', base, users), 'Guna');
  eq(folderOwner('Z:\\Editor Projects\\Yogeshwar\\P1', base, users), null, 'a folder with no user');
  eq(folderOwner('Z:\\Editor Projects\\Project 23 Oct 1625', base, users), null, 'straight in the base folder');
  eq(folderOwner('Z:\\Other\\venky\\P', base, users), null, 'outside the base');
  eq(folderOwner('Z:\\Editor Projects\\Devanshu\\P', base, users), null, '"dev" is not "Devanshu"');
  eq(folderOwner(null, base, users), null);
});

test('🔐 the saved maker comes first (when still in the team), else the folder', () => {
  eq(projectOwner({ by: 'Vishal' }, 'Z:\\Editor Projects\\Guna\\X', base, users), 'vishal', 'saved maker, the team\'s spelling');
  eq(projectOwner({ by: 'Gone Person' }, 'Z:\\Editor Projects\\Guna\\X', base, users), 'Guna', 'a maker no longer in the team: the folder');
  eq(projectOwner({}, 'D:\\Video Editor Agent\\Projects\\X', base, users), null, 'on this PC: the owner\'s');
});

test('🔐 who sees it: the owner and this computer always; a team member only theirs and what is shared with them', () => {
  assert(canSee({ role: 'owner', name: 'jaspreet' }, 'venky', []));
  assert(canSee({ local: true }, 'venky', []));
  assert(canSee({ role: 'editor', name: 'Venky' }, 'venky', []), 'theirs, any case');
  assert(!canSee({ role: 'editor', name: 'vishal' }, 'venky', []));
  assert(canSee({ role: 'editor', name: 'vishal' }, 'venky', ['Vishal']), 'shared with them');
  assert(!canSee({ role: 'viewer', name: 'client' }, 'venky', []));
  assert(!canSee({ role: 'editor', name: '' }, '', []), 'no name: nothing');
});

test('🔐 the project a request is about: ?p=, ?proj=, /pm/… and /pf/…', () => {
  const u = (s) => new URL(s, 'http://x');
  eq(requestProject(u('/api/project?p=Teaser%201')), 'Teaser 1');
  eq(requestProject(u('/api/review/note?proj=Reel')), 'Reel');
  eq(requestProject(u('/pm/My%20Film/abc123/play')), 'My Film');
  eq(requestProject(u('/pf/My%20Film/renders/a.mp4')), 'My Film');
  eq(requestProject(u('/api/projects')), null);
});
