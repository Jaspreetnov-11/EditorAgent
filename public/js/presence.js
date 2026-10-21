// 📊 Sessions: while someone is really working in this tab (it is in front, and the mouse / keys moved in the last
// few minutes) it tells the editor about once a minute, with the open project. The owner sees the time per person in
// Team & users > Sessions. An open but untouched or hidden tab does not count.
import { S } from './store.js';
import { api, enc } from './api.js';

const IDLE = 5 * 60 * 1000, EVERY = 60 * 1000;
let lastInput = Date.now(), lastPing = 0;
const ping = () => {
  if (document.visibilityState !== 'visible' || Date.now() - lastInput > IDLE) return;
  lastPing = Date.now();
  api('GET', `/api/presence${S.proj ? `?p=${enc(S.proj)}` : ''}`).catch(() => {});
};
const touch = () => {
  const was = Date.now() - lastInput;
  lastInput = Date.now();
  if (was > IDLE || Date.now() - lastPing > EVERY) ping(); // back after a break: count it at once
};
for (const ev of ['pointerdown', 'keydown', 'wheel', 'pointermove']) window.addEventListener(ev, touch, { passive: true, capture: true });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') touch(); });
setInterval(ping, EVERY);
