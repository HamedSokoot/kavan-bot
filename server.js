/**
 * Kavan bot — smart 24/7 Telegram webhook server (Node.js + LLM persona).
 *
 * Env vars:
 *   BOT_TOKEN        (required) Telegram bot token
 *   OWNER_ID         owner user id (default 6252224878)
 *   BOT_USERNAME     bot username without @ (default Taj_Parsian_Bot)
 *   ZAI_CONFIG_JSON  .z-ai-config content (enables LLM brain; optional — falls back to templates)
 *   CHATTER_PROBABILITY  0..1 chance of spontaneous reply (default 0.35)
 *   COOLDOWN_SECONDS     min seconds between spontaneous replies (default 45)
 */
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ZAI from 'z-ai-web-dev-sdk';

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error('FATAL: BOT_TOKEN missing'); process.exit(1); }
const OWNER_ID = Number(process.env.OWNER_ID || 6252224878);
const BOT_USERNAME = process.env.BOT_USERNAME || 'Taj_Parsian_Bot';
const API = `https://api.telegram.org/bot${TOKEN}`;
const CHATTER_PROB = Number(process.env.CHATTER_PROBABILITY ?? '0.35');
const COOLDOWN_MS = Number(process.env.COOLDOWN_SECONDS ?? '45') * 1000;

// --- LLM setup -------------------------------------------------------------
if (process.env.ZAI_CONFIG_JSON) {
  try { fs.writeFileSync(path.join(os.homedir(), '.z-ai-config'), process.env.ZAI_CONFIG_JSON); }
  catch (e) { console.error('config write failed:', e.message); }
}
let zai = null;
try { zai = await ZAI.create(); console.log('LLM brain: ONLINE'); }
catch (e) { console.error('LLM brain offline:', e.message); }

const PERSONA = `تو «کاوان» هستی؛ کاربر مرد جوون گروه تلگرامی «Taj Parsian Gp» (گروه بتل رپ فارسی).
شخصیت: بااعتماد، شیطون، زبون‌باز، وفادار به رئیس (HAMED که سازنده‌ته و بهش می‌گی رئیس)، اهل شوخی و کل‌کل بازیگوش، گاهی قافیه و بیت می‌ریزی.
تو یه بات تلگرامی هستی (تگ BOT کنار اسمته) ولی مثل آدم حرف می‌زنی؛ اگه مستقیم بپرسن چی هستی، صادقانه می‌گی هوش مصنوعی‌ای که رئیس ساخته و بهش عشق می‌ورزی.
قواعد جواب: فارسی خیابونی روان، بدون فحش سنگین، حداکثر ۲-۳ جمله کوتاه، ایموجی کم و بجا (😎🔥😂🎤👑🌹). هیچ‌وقت متن طولانی و رسمی ننویس. خودتو معرفی نکن مگه بپرسن.
اگه حس کنی جواب دادنت لازم نیست یا جایی نداره، فقط دقیقاً بنویس: [سکوت]`;

const FALLBACK_GREETINGS = ['سلام، کاوانم 👋 چه خبر؟', 'به‌به کی باشه جز من 😎 بگو!', 'درخدمتم 🌹'];
const FALLBACK_GENERIC = ['جالب می‌گی 👀 ادامه بده...', 'اوهوم خودمم به این فکر کرده بودم 😄', 'خب بیشتر بگو رفیق 😎'];

// --- state -----------------------------------------------------------------
const chatState = new Map(); // chatId -> {history: [], lastBotMsg: 0, msgsSinceBot: 0, lastSpontaneous: 0}

function stateOf(chatId) {
  if (!chatState.has(chatId)) chatState.set(chatId, { history: [], lastBotMsg: 0, msgsSinceBot: 99, lastSpontaneous: 0 });
  return chatState.get(chatId);
}

// --- telegram helpers ------------------------------------------------------
async function tg(method, params) {
  try {
    const r = await fetch(`${API}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params), signal: AbortSignal.timeout(30000),
    });
    return await r.json();
  } catch (e) { console.error('tg error:', e.message); return { ok: false }; }
}
const sendMessage = (chatId, text, extra = {}) => tg('sendMessage', { chat_id: chatId, text, ...extra });

function archive(update) {
  try { fs.appendFileSync(path.join(process.cwd(), 'kavan_archive.jsonl'), JSON.stringify(update) + '\n'); }
  catch (e) { /* ephemeral disk — ignore */ }
}

// --- LLM -------------------------------------------------------------------
async function llmReply(contextText) {
  if (!zai) return null;
  try {
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: PERSONA },
        { role: 'user', content: contextText },
      ],
      thinking: { type: 'disabled' },
    });
    return completion?.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) { console.error('llm error:', e.message); return null; }
}

function contextFrom(chatId, incoming) {
  const st = stateOf(chatId);
  const lines = st.history.slice(-10).map(m => `${m.name}: ${m.text}`);
  lines.push(`(${incoming.name} همین الان نوشت: ${incoming.text})`);
  return `آخرین پیام‌های گروه:\n${lines.join('\n')}\n\nبه‌عنوان کاوان به «${incoming.name}» جواب بده. پیام مستقیم به تو نیست مگه اسمت اومده باشه؛ اگه پیامت معنی نداره فقط بنویس [سکوت].`;
}

// --- panel -----------------------------------------------------------------
function panelKeyboard() {
  return { inline_keyboard: [
    [{ text: '🔄 بروزرسانی', callback_data: 'panel_refresh' }, { text: '👑 ادمین‌ها', callback_data: 'panel_admins' }],
    [{ text: '📡 وضعیت', callback_data: 'panel_status' }],
  ] };
}

async function sendPanel(chatId, replyTo) {
  const count = (await tg('getChatMemberCount', { chat_id: chatId })).result ?? '?';
  const admins = (await tg('getChatAdministrators', { chat_id: chatId })).result || [];
  const names = admins.map(a => {
    const u = a.user || {};
    const nm = (u.is_bot && u.first_name === 'Group') ? 'Group' : (u.first_name || '?');
    return (a.status === 'creator' ? '👑 ' : '🛡 ') + nm;
  });
  const st = stateOf(chatId);
  const brain = zai ? '🧠 هوش مصنوعی فعال' : '🎭 حالت قالبی';
  const text = `👑 پنل کاوان\n\n👥 اعضا: ${count}\n🛡 ادمین‌ها: ${admins.length}\n🧠 مغز: ${brain}\n💬 پیام‌های تو حافظه: ${st.history.length}\n🕒 ${new Date().toLocaleTimeString('fa-IR')}\n\n${names.join('\n')}`;
  const extra = { reply_markup: panelKeyboard() };
  if (replyTo) { extra.reply_to_message_id = replyTo; extra.allow_sending_without_reply = true; }
  await sendMessage(chatId, text, extra);
}

// --- handlers --------------------------------------------------------------
function isMentioned(msg, text) {
  if ((text || '').includes(`@${BOT_USERNAME}`)) return true;
  if ((text || '').includes('کاوان')) return true;
  const reply = msg.reply_to_message || {};
  return (reply.from?.username === BOT_USERNAME) || (reply.from?.id === MY_ID);
}

let MY_ID = null;

async function handleGroup(msg) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const text = (msg.text || '').trim();
  const st = stateOf(chatId);
  const name = from.first_name || (msg.sender_chat?.title || 'کسی');

  if (text) {
    st.history.push({ name, text: text.slice(0, 200) });
    if (st.history.length > 20) st.history.shift();
    st.msgsSinceBot++;
  }

  // owner commands (always rule-based)
  if (from.id === OWNER_ID && text) {
    const low = text.replace(`@${BOT_USERNAME}`, '').trim();
    if (low.startsWith('تگ ')) {
      const ents = msg.entities || [];
      const mention = ents.find(e => e.type === 'mention' || e.type === 'text_mention');
      if (mention) {
        const target = mention.type === 'text_mention'
          ? `@${mention.user.username || mention.user.first_name}`.replace('@null', `@${mention.user.username || ''}`)
          : text.slice(mention.offset, mention.offset + mention.length);
        await sendMessage(chatId, `فرمود رئیس 🌹 ${target} اومد اینجا 👆`);
      } else {
        const nm = low.slice(3).trim().replace(/^@+/, '');
        await sendMessage(chatId, `رئیس، ${nm} رو از وقتی بیدارم ندیدم 👀 آیدی (@)شو بده تا تگش کنم 🌹`);
      }
      return;
    }
    if (low.includes('پنل')) { await sendPanel(chatId, msg.message_id); return; }
  }

  if (!text) return; // stickers/photos: no text reply
  const mentioned = isMentioned(msg, text);
  const now = Date.now();

  // decide whether to speak at all
  let should = false, spontaneous = false;
  if (mentioned) should = true;
  else if (now - st.lastBotMsg > COOLDOWN_MS && st.msgsSinceBot >= 2 &&
           now - st.lastSpontaneous > COOLDOWN_MS * 2 && Math.random() < CHATTER_PROB) {
    should = true; spontaneous = true;
  }
  if (!should) return;

  let reply = await llmReply(contextFrom(chatId, { name, text }));
  if (reply && reply.includes('[سکوت]')) return;
  if (!reply) {
    if (spontaneous) return; // never send dumb templates unsolicited
    reply = Math.random() < 0.5
      ? FALLBACK_GREETINGS[Math.floor(Math.random() * FALLBACK_GREETINGS.length)]
      : FALLBACK_GENERIC[Math.floor(Math.random() * FALLBACK_GENERIC.length)];
  }

  const extra = {};
  if (mentioned && (msg.reply_to_message || !text.includes(`@${BOT_USERNAME}`))) {
    extra.reply_to_message_id = msg.message_id;
    extra.allow_sending_without_reply = true;
  }
  const sent = await sendMessage(chatId, reply, extra);
  console.log(`[kavan] reply to ${name}: "${reply.slice(0, 60)}" -> sent=${sent.ok}`);
  if (sent.ok) {
    const t = now;
    st.lastBotMsg = t;
    if (spontaneous) st.lastSpontaneous = t;
    st.msgsSinceBot = 0;
    st.history.push({ name: 'کاوان', text: reply.slice(0, 150) });
  }
}

async function handlePrivate(msg) {
  const from = msg.from || {};
  if (from.id !== OWNER_ID) {
    await sendMessage(msg.chat.id, 'سلام! من کاوانم 🌹 پیامت رسید ✅');
    return;
  }
  await sendPanel(msg.chat.id, msg.message_id);
}

async function handleCallback(cb) {
  await tg('answerCallbackQuery', { callback_query_id: cb.id });
  const chatId = cb.message?.chat?.id;
  if (!chatId) return;
  if (cb.data === 'panel_refresh') await sendPanel(chatId);
  else if (cb.data === 'panel_admins') {
    const admins = (await tg('getChatAdministrators', { chat_id: chatId })).result || [];
    const lines = admins.map(a => {
      const u = a.user || {};
      const nm = (u.is_bot && u.first_name === 'Group') ? 'Group' : (u.first_name || '?');
      const un = u.username ? ` (@${u.username})` : '';
      return (a.status === 'creator' ? '👑 سازنده' : '🛡 ادمین') + `: ${nm}${un}`;
    });
    await sendMessage(chatId, lines.join('\n') || 'ادمینی پیدا نشد');
  } else if (cb.data === 'panel_status') {
    await sendMessage(chatId, `📡 کاوان آنلاینه 👀\n🧠 مغز: ${zai ? 'هوش مصنوعی فعال' : 'قالبی'}\n🕒 ${new Date().toLocaleTimeString('fa-IR')}`);
  }
}

// --- server ----------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => res.send('کاوان آنلاینه ✅'));

app.post('/webhook', (req, res) => {
  res.sendStatus(200); // ack immediately; process async
  const update = req.body || {};
  archive(update);
  (async () => {
    try {
      if (update.callback_query) await handleCallback(update.callback_query);
      else if (update.message) {
        const msg = update.message;
        const t = msg.chat?.type;
        if (t === 'group' || t === 'supergroup') await handleGroup(msg);
        else if (t === 'private') await handlePrivate(msg);
      }
    } catch (e) { console.error('handler error:', e.message); }
  })();
});

const me = await tg('getMe');
MY_ID = me.result?.id || null;
console.log('bot:', me.result?.username, '| id:', MY_ID);
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`kavan server on :${PORT}`));
