// templates.mjs - ⚡ Limelight Flow's ready flows: added from the Flows page (+ From a template), off until switched on.
// Each comes for Telegram (your own bot - official, free, nothing to install) and for WhatsApp (a spare SIM). They use
// Settings > Variables: ownerTelegram (your chat id, shown on the Telegram page once you have written to the bot) and
// ownerPhone (the WhatsApp number, with country code) - who gets the messages and who may talk to the bot.

const HELP = [
  '🤖 *Limelight bot* - likhiye:',
  '• *online* - abhi kaun editor par hai',
  '• *report* - aaj ka hisaab (kisne kitna kaam kiya, renders, editor ki sehat)',
  '• kuch bhi aur poochhiye - jaise "is hafte sabse zyada kaam kisne kiya?" - Limelight AI editor ke figures dekh kar jawab dega',
].join('\n');
const CH = { telegram: { label: 'Telegram', owner: 'ownerTelegram', send: 'telegram.send' }, whatsapp: { label: 'WhatsApp', owner: 'ownerPhone', send: 'whatsapp.send' } };

const report = (ch) => ({
  name: `Roz raat 10 baje ki report (${CH[ch].label})`,
  note: `Every day at 22:00: the editor's day report (who worked, on what, renders, health) on ${CH[ch].label} to ${CH[ch].owner}.`,
  flow: {
    trigger: { type: 'schedule', at: '22:00', days: '', every: '' },
    steps: [
      { id: 'report', type: 'limelight.report', params: { day: '' } },
      { id: 'send', type: CH[ch].send, params: { to: `{{vars.${CH[ch].owner}}}`, text: '{{steps.report.text}}' } },
    ],
  },
});
const chatbot = (ch) => ({
  name: `${CH[ch].label} chatbot (editor se baat)`,
  note: `A ${CH[ch].label} message from ${CH[ch].owner}: "online", "report", "help" are answered from the editor at once; anything else goes to Limelight AI, who answers from the editor's figures (it reads no files).`,
  flow: {
    trigger: { type: ch, from: `{{vars.${CH[ch].owner}}}`, match: '', groups: 'no' },
    steps: [
      { id: 'route', type: 'code', name: 'What is asked', params: { code: "const t = String(trigger.text || '').toLowerCase().trim().replace(/^\\//, '');\nif (/^(help|start|madad|menu|\\?)$/.test(t)) return 'help';\nif (/\\b(online|kaun hai|kon hai|who is)\\b/.test(t)) return 'online';\nif (/^(report|aaj ka report|aaj|today|summary|hisaab)$/.test(t)) return 'report';\nreturn 'ask';" } },
      { id: 'online', type: 'limelight.online', if: "steps.route === 'online'", params: {} },
      { id: 'report', type: 'limelight.report', if: "steps.route === 'report'", params: { day: '' } },
      { id: 'ask', type: 'limelight.ask', if: "steps.route === 'ask'", params: { question: '{{trigger.text}}' } },
      { id: 'reply', type: 'code', name: 'The answer', params: { code: `const help = ${JSON.stringify(HELP)};\nreturn { text: steps.route === 'help' ? help : steps.route === 'online' ? steps.online.text : steps.route === 'report' ? steps.report.text : steps.ask.answer };` } },
      { id: 'send', type: CH[ch].send, params: { to: '{{trigger.chat}}', text: '{{steps.reply.text}}' } },
    ],
  },
});
const alerts = (ch) => ({
  name: `Alerts (office watch) ${CH[ch].label} par`,
  note: `A webhook: the office watch (engine/uptime.mjs, "flow" in uptime.json) and any other program send their alert here and it goes on ${CH[ch].label} to ${CH[ch].owner}. Its address is shown in the trigger once saved.`,
  flow: {
    trigger: { type: 'webhook', key: '' },
    steps: [{ id: 'send', type: CH[ch].send, params: { to: `{{vars.${CH[ch].owner}}}`, text: '{{trigger.body?.text || trigger.query.text || JSON.stringify(trigger.body)}}' } }],
  },
});

export const TEMPLATES = {
  tgReport: report('telegram'), tgChatbot: chatbot('telegram'), tgAlerts: alerts('telegram'),
  report: report('whatsapp'), chatbot: chatbot('whatsapp'), alerts: alerts('whatsapp'),
};
