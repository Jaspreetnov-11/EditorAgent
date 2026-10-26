// whatsapp.mjs - 💬 Limelight Flow's WhatsApp: a spare SIM's WhatsApp joined as a linked device (like WhatsApp Web - a QR
// code scanned once from that phone), through the open-source Baileys library. Sends messages and hears the ones that
// come in, so flows can start on a message and answer it. Use a spare number only: this is not WhatsApp's official
// API, and WhatsApp may block a number that sends like a bot (keep to your own people and replies).
// Baileys is not part of the editor: `npm install` in flow/ brings it (see flow/package.json). Without it this says so.
import fs from 'node:fs';
import path from 'node:path';

export class WhatsApp {
  constructor(dir, onMessage, log = () => {}) {
    this.dir = dir; this.onMessage = onMessage; this.log = log;
    this.state = 'off'; this.qr = null; this.me = null; this.error = null; this.sock = null; this.lib = null; this.tries = 0;
  }
  view() { return { state: this.state, qr: this.qr, me: this.me, error: this.error, installed: this.lib !== false }; }

  async start() {
    if (this.sock || this.state === 'starting') return;
    this.state = 'starting'; this.error = null;
    try { this.lib ||= await import('@whiskeysockets/baileys'); }
    catch { this.lib = false; this.state = 'not installed'; this.error = 'The WhatsApp library is not installed: run "npm install" in the flow folder'; return; }
    const B = this.lib, make = B.default?.default || B.default || B.makeWASocket;
    let logger; try { logger = (await import('pino')).default({ level: 'silent' }); } catch {}
    const { state, saveCreds } = await B.useMultiFileAuthState(path.join(this.dir, 'whatsapp-login'));
    let version; try { version = (await B.fetchLatestBaileysVersion()).version; } catch {}
    const sock = make({ auth: state, ...(version ? { version } : {}), ...(logger ? { logger } : {}), browser: ['Limelight Flow', 'Chrome', '1.0'], markOnlineOnConnect: false, syncFullHistory: false });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => {
      if (u.qr) { this.qr = u.qr; this.state = 'scan the QR'; }
      if (u.connection === 'open') { this.state = 'connected'; this.qr = null; this.tries = 0; this.me = String(sock.user?.id || '').split(/[:@]/)[0]; this.log(`WhatsApp connected as ${this.me}`); }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        this.sock = null; this.qr = null;
        if (code === B.DisconnectReason?.loggedOut) {
          this.state = 'logged out'; this.error = 'The phone removed this linked device - connect again';
          fs.rmSync(path.join(this.dir, 'whatsapp-login'), { recursive: true, force: true });
          return;
        }
        this.state = 'reconnecting'; this.error = u.lastDisconnect?.error?.message || null;
        setTimeout(() => this.start().catch((e) => { this.state = 'error'; this.error = e.message; }), Math.min(60e3, 2000 * 2 ** this.tries++));
      }
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (m.key?.fromMe) continue;
        const text = m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || '';
        if (!text) continue;
        const chat = m.key.remoteJid, group = String(chat).endsWith('@g.us');
        // (the sender's number: newer WhatsApp hides it behind a "lid" - the phone-number form is in the *Pn / *Alt fields)
        const ids = [m.key.senderPn, m.key.participantPn, m.key.remoteJidAlt, m.key.participantAlt, group ? m.key.participant : chat].filter(Boolean);
        const pn = ids.find((x) => String(x).endsWith('@s.whatsapp.net')) || ids[0] || '';
        this.onMessage({ from: String(pn).split(/[:@]/)[0], name: m.pushName || '', text, chat, group });
      }
    });
  }

  async stop(logout = false) {
    const s = this.sock; this.sock = null;
    if (s) { try { if (logout) await s.logout(); else s.end(undefined); } catch {} }
    if (logout) fs.rmSync(path.join(this.dir, 'whatsapp-login'), { recursive: true, force: true });
    this.state = 'off'; this.qr = null;
  }

  // to: a number with its country code (9198…), a chat id (…@s.whatsapp.net / …@g.us / …@lid) or a group's name
  async send(to, text) {
    if (!this.sock || this.state !== 'connected') throw new Error(`WhatsApp is not connected (${this.state})`);
    let jid = String(to).trim();
    if (!jid.includes('@')) {
      if (/^\+?[\d\s-]{8,}$/.test(jid)) jid = `${jid.replace(/\D/g, '')}@s.whatsapp.net`;
      else { const g = (await this.groups()).find((x) => x.name.toLowerCase() === jid.toLowerCase()); if (!g) throw new Error(`No WhatsApp group named "${to}"`); jid = g.id; }
    }
    await this.sock.sendMessage(jid, { text: String(text).slice(0, 4000) });
  }
  async groups() {
    if (!this.sock || this.state !== 'connected') return [];
    const all = await this.sock.groupFetchAllParticipating();
    return Object.values(all).map((g) => ({ id: g.id, name: g.subject, size: g.participants?.length || 0 }));
  }
}
