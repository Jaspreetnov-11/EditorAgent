// telegram.mjs - ✈ Limelight Flow's Telegram: a bot of your own (made in Telegram with @BotFather, which gives its token).
// Telegram's official Bot API, free, nothing to install, and no address to open on the router: this asks Telegram for
// new messages itself (long polling, getUpdates) and sends with sendMessage. A person writes to the bot once (Start),
// and the bot can then answer them and send them the reports - their chat id shows on the Telegram page.
const API = 'https://api.telegram.org';
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// the reports are written with WhatsApp's *bold*: the same look here (HTML), everything else as it is
export const toTelegramHtml = (text) => escHtml(text).replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:])/g, '$1<b>$2</b>');

export class Telegram {
  constructor(getToken, onMessage, log = () => {}) {
    this.getToken = getToken; this.onMessage = onMessage; this.log = log;
    this.state = 'off'; this.me = null; this.error = null; this.offset = 0; this.loop = null; this.recent = []; this.ctl = null;
  }
  view() { return { state: this.state, me: this.me, error: this.error, recent: this.recent }; }
  async call(method, body, timeoutMs = 30e3) {
    const tok = this.getToken();
    if (!tok) throw new Error('No bot token - make a bot with @BotFather and paste its token');
    this.ctl = new AbortController();
    const t = setTimeout(() => this.ctl.abort(), timeoutMs);
    try {
      const r = await fetch(`${API}/bot${tok}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: this.ctl.signal });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.description || `Telegram answered ${r.status}`);
      return j.result;
    } finally { clearTimeout(t); }
  }
  async start() {
    if (this.loop) return;
    this.state = 'starting'; this.error = null;
    try { const me = await this.call('getMe'); this.me = me.username; }
    catch (e) { this.state = 'error'; this.error = e.message; return; }
    this.state = 'connected'; this.log(`Telegram bot @${this.me} is on`);
    let fails = 0;
    this.loop = (async () => {
      while (this.state === 'connected') {
        try {
          const ups = await this.call('getUpdates', { offset: this.offset, timeout: 50, allowed_updates: ['message'] }, 65e3);
          fails = 0;
          for (const u of ups) {
            this.offset = u.update_id + 1;
            const m = u.message;
            if (!m?.text || m.from?.is_bot) continue;
            const who = { id: String(m.from.id), username: m.from.username || '', name: [m.from.first_name, m.from.last_name].filter(Boolean).join(' '), chat: String(m.chat.id), group: m.chat.type !== 'private', at: Date.now() };
            this.recent = [who, ...this.recent.filter((x) => x.chat !== who.chat)].slice(0, 10);
            this.onMessage({ from: who.id, username: who.username, name: who.name, text: m.text, chat: who.chat, group: who.group });
          }
        } catch (e) {
          if (this.state !== 'connected') break;
          this.error = e.message; await sleep(Math.min(60e3, 2000 * 2 ** fails++));
        }
      }
      this.loop = null;
    })();
  }
  async stop() { this.state = 'off'; try { this.ctl?.abort(); } catch {} }
  async send(chat, text) {
    if (this.state !== 'connected') throw new Error(`Telegram is not on (${this.state})`);
    const to = String(chat).trim();
    if (!/^-?\d+$/.test(to)) throw new Error(`"${to}" is not a Telegram chat id - the person writes to the bot once, then their id shows on the Telegram page`);
    for (let i = 0, s = String(text); i < s.length; i += 4000) await this.call('sendMessage', { chat_id: to, text: toTelegramHtml(s.slice(i, i + 4000)), parse_mode: 'HTML', disable_web_page_preview: true });
  }
}
