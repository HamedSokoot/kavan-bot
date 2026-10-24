/**
 * Kavan bot v4.0 — dual-token human-like group member with structured memory.
 *
 * Architecture (spec §16 pipeline), one responsibility per module:
 *   lib/env.js          shared runtime config (secrets only via env vars)
 *   lib/normalizer.js   Persian NLP: char/ZWNJ/diacritics/skeleton matching (§8)
 *   lib/store.js        durable storage: local JSON + private GitHub repo sync (§2.5, §15)
 *   lib/db.js           entities: users/aliases/profiles/memories/learned/events/privacy (§1,§2,§3,§7,§15)
 *   lib/events.js       group event detection: joins/leaves/fights/agreements (§6)
 *   lib/relations.js    friendship/trust/conflict indices + romance FSM (§5, §12)
 *   lib/nlu.js          Persian intent detection + param extraction (§10)
 *   lib/intent-handlers.js  real tool executors behind intents (§10.3)
 *   lib/persona.js      personality + tone adaptation + prompt assembly (§4)
 *   lib/brain.js        LLM chain: OpenRouter deepseek → Pollinations, fallbacks (§15.4)
 *
 * Env:
 *   BOT_TOKEN / BOT2_TOKEN   Telegram bot tokens           [required]
 *   OWNER_ID                 owner user id
 *   OPENROUTER_API_KEY       stronger brain (used first)   [recommended]
 *   OPENROUTER_MODELS        models list (default deepseek-v4-flash,deepseek-v3.2)
 *   GITHUB_TOKEN/GITHUB_REPO private repo for memory sync  [recommended]
 *   CHATTER_PROBABILITY, COOLDOWN_SECONDS, OBSERVE_MSGS, HOURLY_MSG_CAP
 *   KAVAN_DRYRUN=1           log instead of sending (testing)
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import * as store from './lib/store.js';
import * as db from './lib/db.js';
import * as events from './lib/events.js';
import * as rel from './lib/relations.js';
import * as nlu from './lib/nlu.js';
import * as handlers from './lib/intent-handlers.js';
import * as persona from './lib/persona.js';
import * as brain from './lib/brain.js';
import { polish, mentionsBot, MENTION_FALLBACKS, ACCUSE_FALLBACKS, pickFb } from './lib/polish.js';
import { OWNER_ID, OWNER_SIG, DRY, CHATTER_PROB, COOLDOWN_MS, OBSERVE_MSGS, HOURLY_MSG_CAP } from './lib/env.js';
import { normalize, hardStop } from './lib/normalizer.js';

const ARCHIVE = path.join(process.cwd(), 'kavan_archive.jsonl');

// --- telegram ---------------------------------------------------------------
async function call(token, method, params) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params), signal: AbortSignal.timeout(30000),
    });
    return await r.json();
  } catch (e) { console.error('tg error:', method, e.message); return { ok: false }; }
}

// --- bots -------------------------------------------------------------------
const BOTS = [];
for (const tok of [process.env.BOT_TOKEN, process.env.BOT2_TOKEN]) {
  if (!tok) continue;
  const me = await call(tok, 'getMe', {});
  if (me?.ok) BOTS.push({ idx: BOTS.length, token: tok, id: me.result.id, username: me.result.username, name: me.result.first_name });
  else console.error('invalid token skipped');
}
if (!BOTS.length) { console.error('FATAL: no valid bot token'); process.exit(1); }
const botById = id => BOTS.find(b => b.id === id);
const PRIMARY = 0;

// --- boot: storage (local → remote → migrate old format) --------------------
store.load();
const pulled = await store.pullRemote(store.getData());
console.log('storage:', JSON.stringify({ ...pulled, backend: store.status().backend }));
migrateOldMemory();
store.startAutoSync();

// old v3.6 kavan_memory.json → structured db (one-time, §15 controlled migration)
function migrateOldMemory() {
  if (Object.keys(db.db().users || {}).length) return;
  try {
    const old = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'kavan_memory.json'), 'utf-8'));
    let migrated = 0;
    for (const [cid, c] of Object.entries(old.chats || {})) {
      for (const [uid, p] of Object.entries(c.users || {})) {
        db.ensureUser(uid, p.name, p.username);
        const u = db.getUser(uid);
        if (u && p.texts?.length) {
          u.groups[cid] = { count: p.texts.length * 3, emoji: !!p.emoji, avgLen: p.avgLen || 20, lastTexts: p.texts.slice(-5) };
          migrated++;
        }
      }
      if (c.history?.length) db.db().chatHistory[cid] = c.history.slice(-30).map(h => ({ name: h.name, uid: 0, text: h.text, t: Date.now() - 3600e3 }));
    }
    if (migrated) { store.markDirty(); store.persistLocal(); console.log(`migrated old memory: ${migrated} user-records`); }
  } catch (_) { /* no old file */ }
}

function archive(bot, update) {
  if (DRY) return;
  try { fs.appendFileSync(ARCHIVE, JSON.stringify({ bot: bot?.username, ...update }) + '\n'); }
  catch (e) { /* ephemeral disk */ }
}

// §10.3 outgoing filter lives in lib/polish.js (independently testable, §17)

// --- panel (owner) ----------------------------------------------------------
const panelKeyboard = () => ({ inline_keyboard: [
  [{ text: '🔄 بروزرسانی', callback_data: 'panel_refresh' }, { text: '👑 ادمین‌ها', callback_data: 'panel_admins' }],
  [{ text: '📡 وضعیت', callback_data: 'panel_status' }, { text: '🧠 حافظه', callback_data: 'panel_memory' }],
] });

async function sendPanel(bot, chatId, replyTo) {
  const count = (await call(bot.token, 'getChatMemberCount', { chat_id: chatId })).result ?? '?';
  const admins = (await call(bot.token, 'getChatAdministrators', { chat_id: chatId })).result || [];
  const names = admins.map(a => {
    const u = a.user || {};
    const nm = (u.is_bot && u.first_name === 'Group') ? 'Group' : (u.first_name || '?');
    return (a.status === 'creator' ? '👑 ' : '🛡 ') + nm;
  });
  const s = db.stats();
  const st = store.status();
  const text = `👑 پنل کاوان\n\n👥 اعضا: ${count}\n🛡 ادمین‌ها: ${admins.length}\n🧠 مغز: ${brain.status().brain}\n💾 حافظه: ${s.users} کاربر، ${s.memories} خاطره، ${s.events} رویداد، ${s.learned} اصطلاح\n❤️ عاطفی: ${s.romances}\n☁️ سینک: ${st.backend}${st.lastSync ? ' (' + st.lastSync.slice(11, 19) + ' UTC)' : ''}\n📖 حافظه‌ی گفتگو: ${db.chatHistory(chatId).length} پیام\n🕒 ${new Date().toLocaleTimeString('fa-IR')}\n\n${names.join('\n')}`;
  const extra = { reply_markup: panelKeyboard() };
  if (replyTo) { extra.reply_to_message_id = replyTo; extra.allow_sending_without_reply = true; }
  await call(bot.token, 'sendMessage', { chat_id: chatId, text, ...extra });
}

// --- helpers ----------------------------------------------------------------
const hashN = (...nums) => { let h = 2166136261; for (const n of nums) { h ^= n; h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
const isOwnerMsg = msg => msg.from?.id === OWNER_ID || msg.author_signature === OWNER_SIG;
const delayMs = () => 2000 + Math.floor(Math.random() * 6000);

async function sendAs(bot, chatId, text, extra = {}) {
  if (DRY) { console.log(`[dry] bot${bot.idx} -> chat ${chatId}: ${text.slice(0, 90)}`); return { ok: true, result: { message_id: Math.floor(Math.random() * 1e6) } }; }
  const r = await call(bot.token, 'sendMessage', { chat_id: chatId, text, ...extra });
  if (r.ok && r.result?.message_id) ownMessages.set(r.result.message_id, bot.idx);
  return r;
}

// real text_mention for users without usernames (§3.4) — no fake links
async function sendMention(bot, chatId, uid, name, prefix, replyTo) {
  const label = name.startsWith('@') ? name : `@${name}`;
  const text = `${prefix} ${label} اومد اینجا 👆`;
  const params = { chat_id: chatId, text, reply_to_message_id: replyTo, allow_sending_without_reply: true };
  if (!name.startsWith('@')) {
    params.entities = [{ offset: text.indexOf(label), length: label.length, type: 'text_mention', user: { id: Number(uid), first_name: name, is_bot: false } }];
  }
  return call(bot.token, 'sendMessage', params);
}

function pickReaction(text) {
  const t = text || '';
  if (/😂|🤣|خخ|ههه|لطیف|جک|شوخی|مسخره/.test(t)) return '🤣';
  if (/رپ|بتل|بیت|دیس|قافیه|فلو|موزیک|ترک|خواننده|آهنگ/i.test(t)) return '🔥';
  const REACT_POOL = ['🔥', '👏', '💯', '🤣', '⚡', '🏆', '❤', '🫡', '🤔'];
  return REACT_POOL[Math.floor(Math.random() * REACT_POOL.length)];
}

const membershipCache = new Map();
async function twinInGroup(chatId, bot) {
  const twin = BOTS.find(b => b.idx !== bot.idx);
  if (!twin) return false;
  const key = `${chatId}:${twin.id}`;
  const now = Date.now();
  const c = membershipCache.get(key);
  if (c && now - c.at < 60000) return c.inGroup;
  const r = await call(bot.token, 'getChatMember', { chat_id: chatId, user_id: twin.id });
  const inGroup = !!r?.ok && ['member', 'administrator', 'creator', 'restricted'].includes(r.result?.status);
  membershipCache.set(key, { inGroup, at: now });
  return inGroup;
}

// §13.2 anti-spam: hourly per-chat cap + update dedupe
const hourlyCount = new Map(); // chatId:hour -> n
function hourlyOk(chatId) {
  const key = `${chatId}:${Math.floor(Date.now() / 3600000)}`;
  const n = hourlyCount.get(key) || 0;
  if (n >= HOURLY_MSG_CAP) return false;
  hourlyCount.set(key, n + 1);
  if (hourlyCount.size > 500) { for (const k of hourlyCount.keys()) { if (!k.endsWith(`:${Math.floor(Date.now() / 3600000)}`)) hourlyCount.delete(k); if (hourlyCount.size <= 250) break; } }
  return true;
}
const seenUpdates = new Set();
function updateDedupe(id) {
  if (seenUpdates.has(id)) return false;
  seenUpdates.add(id);
  if (seenUpdates.size > 5000) { const it = seenUpdates.values(); for (let i = 0; i < 1000; i++) seenUpdates.delete(it.next().value); }
  return true;
}

const ownMessages = new Map();

// --- privacy gate (§14): forget-tombstoned users stay silent-ignored ----------
function privacyBlocked(uid) {
  const p = db.privacyOf(uid);
  return !!(p?.forgetRequested);
}

// ============================================================================
// --- group logic (§16 pipeline) ---------------------------------------------
async function handleGroup(msg, bot) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const rawText = (msg.text || '').trim();
  const t = (msg.date || Math.floor(Date.now() / 1000)) * 1000;

  // our own twin's message → mark & never react
  const selfBot = botById(from.id);
  if (selfBot) { ownMessages.set(msg.message_id, selfBot.idx); return; }
  if (from.is_bot && !isOwnerMsg(msg)) return;

  // §6.1 service events (joins/leaves) — real, verified
  if (events.onService(chatId, msg)) return;

  const owner = isOwnerMsg(msg);
  const name = owner && msg.author_signature ? msg.author_signature : (from.first_name || msg.sender_chat?.title || 'کسی');

  // §1/§2.1: register user + observe message (normalized inside db)
  if (!privacyBlocked(from.id)) {
    db.observeMessage(chatId, from.id, name, from.username, rawText, t);
    rel.bump(chatId, from.id, 'fam', 0.3, 'حضور در گروه');
  }

  // §6: content-based event detection
  if (rawText && !privacyBlocked(from.id)) events.onMessage(chatId, from.id, name, rawText);

  // --- owner commands (always honored, §14.2) ---
  if (owner && rawText) {
    const low = rawText.replace(new RegExp(`@${bot.username}`, 'g'), '').trim();
    if (/(^|\s)تگ(\s|$)|تگش|تگ کن/.test(low)) {
      const ents = msg.entities || [];
      const mention = ents.find(e => e.type === 'mention' || e.type === 'text_mention');
      if (mention) {
        const target = mention.type === 'text_mention'
          ? (mention.user.username ? `@${mention.user.username}` : mention.user.first_name)
          : rawText.slice(mention.offset, mention.offset + mention.length);
        await sendAs(bot, chatId, `فرمود رئیس 🌹 ${target} اومد اینجا 👆`, { reply_to_message_id: msg.message_id, allow_sending_without_reply: true });
      } else {
        const stop = new Set(['رو', 'تو', 'تگ', 'کن', 'بکن', 'کنه', 'لطفا', 'خواهش', 'میشه', 'بفرما', 'کنی', 'شد']);
        const nm = low.split(/[\s،.!؟?]+/).filter(w => w && !stop.has(w) && !w.startsWith('@')).join(' ') || '';
        const cands = nm ? db.searchPeople(chatId, nm, { limit: 2 }) : [];
        if (cands.length === 1) {
          const u = db.getUser(cands[0].uid);
          const label = u.usernames[0] ? `@${u.usernames[0]}` : u.names[0];
          await sendMention(bot, chatId, u.id, label, 'فرمود رئیس 🌹', msg.message_id);
        } else if (cands.length > 1) {
          await sendAs(bot, chatId, `رئیس ${cands.length} تا «${nm}» داریم 😅 ${cands.map(c => `«${c.name}»`).join('، ')} — کدوم؟`, { reply_to_message_id: msg.message_id, allow_sending_without_reply: true });
        } else {
          await sendAs(bot, chatId, `رئیس، ${nm || 'این نفر'} رو هنوز ندیدم تو گروه 👀 آیدی (@)شو بده تا صداش کنم 🌹`, { reply_to_message_id: msg.message_id, allow_sending_without_reply: true });
        }
      }
      return;
    }
    if (low.includes('پنل') || low.includes('وضعیت')) { await sendPanel(bot, chatId, msg.message_id); return; }
  }

  if (!rawText) return;

  // --- who acts (deterministic, both webhooks evaluate identically) ---
  const reply = msg.reply_to_message || {};
  const replyOwnerIdx = ownMessages.get(reply.message_id);
  const mentionsThis = rawText.includes(`@${bot.username}`);
  const mentionsOther = BOTS.some(b => b.idx !== bot.idx && rawText.includes(`@${b.username}`));
  const namedKavan = /کاوان/i.test(rawText);
  const toks = rawText.toLowerCase().split(/[\s.,!?؟…:;()[\]"'»«\-_/\\]+/).filter(Boolean);
  const accused = toks.includes('رباتی') || toks.includes('باتی') || ((toks.includes('ربات') || toks.includes('بات')) && (toks.includes('تو') || toks.includes('خودت') || toks.includes('شما')));

  let actor = -1;
  if (mentionsThis || replyOwnerIdx === bot.idx) actor = bot.idx;
  else if (mentionsOther || (replyOwnerIdx !== undefined && replyOwnerIdx !== bot.idx)) {
    const twinOk = BOTS.length > 1 ? await twinInGroup(chatId, bot) : false;
    actor = twinOk ? -1 : bot.idx;
  } else {
    const twinOk = BOTS.length > 1 ? await twinInGroup(chatId, bot) : false;
    const h = hashN(chatId, msg.message_id);
    const want = !twinOk ? bot.idx : ((h % 100 < 70) ? PRIMARY : (1 - PRIMARY));
    if (bot.idx === want) actor = bot.idx;
  }
  if (actor !== bot.idx) return;

  const incoming = { uid: from.id || 0, name, text: rawText };

  // --- §10: intent detection BEFORE deciding to chat ---
  const det = nlu.detect(rawText, { isOwner: owner, mentionsKavan: mentionsThis || namedKavan });
  const toolIntents = ['search_person', 'ask_person_info', 'teach_identity', 'teach_term', 'correct_info', 'ask_memory', 'ask_events', 'request_report', 'request_dis', 'manage_forget', 'ask_about_me', 'romance_hit', 'romance_break'];

  // tool intents run regardless of chatter probability (user asked for something real)
  if (det && toolIntents.includes(det.intent)) {
    if (!hourlyOk(chatId) && det.intent !== 'manage_forget') return;
    const ctx = {
      chatId, msg, bot, uid: from.id, name, isOwner: owner,
      text: rawText, mentionsKavan: mentionsThis || namedKavan,
      replyFrom: reply.from ? { id: reply.from.id, first_name: reply.from.first_name || '?', username: reply.from.username, message_id: reply.message_id } : null,
    };
    const res = await handlers.runIntent(det, ctx);
    if (res) {
      // §10.3: verify tool result before speaking
      if (res.mention) {
        await sendMention(bot, chatId, res.mention.uid, res.mention.name.startsWith('@') ? res.mention.name : `@${res.mention.name}`, res.reply || 'بفرما 👀', res.replyTo || msg.message_id);
        return;
      }
      const replyText = await polish(chatId, res.reply, { force: true, fallbacks: MENTION_FALLBACKS, rawText });
      if (replyText) {
        await sendAs(bot, chatId, replyText, { reply_to_message_id: res.replyTo || msg.message_id, allow_sending_without_reply: true });
        console.log(`[kavan${bot.idx}] intent:${det.intent} -> ${name}: "${replyText.slice(0, 60)}"`);
        db.pushOwnReply(chatId, replyText);
        db.chatHistory(chatId).push({ name: 'کاوان', uid: 0, text: replyText.slice(0, 150), t: Date.now() });
        if (db.chatHistory(chatId).length > 30) db.chatHistory(chatId).shift();
        store.markDirty();
        rel.bump(chatId, from.id, 'int', 1, 'تعامل قصدمحور');
      }
      return;
    }
    // handler returned nothing → fall through to normal chat
  }

  // --- reactions (cheap, human) ---
  if (!mentionsThis && !namedKavan && replyOwnerIdx === undefined) {
    const observing = db.chatHistory(chatId).length < OBSERVE_MSGS && Date.now() - t < 10 * 60 * 1000;
    const reactProb = observing ? 0.06 : (owner ? 0.18 : 0.10);
    if (Math.random() < reactProb) {
      const emoji = pickReaction(rawText);
      setTimeout(() => { if (!DRY) call(bot.token, 'setMessageReaction', { chat_id: chatId, message_id: msg.message_id, reaction: [{ type: 'emoji', emoji }] }); }, 800 + Math.floor(Math.random() * 3000));
      return;
    }
  }

  // --- speak? (§13) ---
  const now = Date.now();
  const st = db.chatHistory(chatId);
  let should = false, force = false;
  if (mentionsThis || namedKavan || replyOwnerIdx !== undefined || accused) { should = true; force = true; }
  else if (st.length >= OBSERVE_MSGS && Math.random() < CHATTER_PROB && Math.random() < 1) {
    should = true;
  }
  if (!should) return;
  if (!hourlyOk(chatId)) return;

  // §13.2 spacing between Kavan's messages (per chat, in-memory)
  if (!handleGroup._last) handleGroup._last = new Map();
  const lastBot = handleGroup._last.get(chatId) || 0;
  if (now - lastBot < COOLDOWN_MS && !force) return;
  handleGroup._last.set(chatId, now);

  // human reading+typing delay, then LLM (§16 steps 7-13)
  setTimeout(async () => {
    try {
      const sys = persona.buildSystem(chatId, { senderUid: from.id, senderName: name, force });
      let userCtx = persona.buildContext(chatId, incoming);
      if (force) userCtx += '\n\n(این پیام مستقیم به توئه — حتماً یه جواب کوتاه طبیعی بده؛ [سکوت] اینجا مجاز نیست.)';
      let raw = null;
      try { raw = await brain.brainChat([{ role: 'system', content: sys }, { role: 'user', content: userCtx }]); } catch (e) { console.error('brain fail:', e.message); }
      const replyText = await polish(chatId, raw, { force, fallbacks: accused ? ACCUSE_FALLBACKS : MENTION_FALLBACKS, rawText });
      if (!replyText) return; // silence is human too
      const extra = {};
      if (force && Math.random() > 0.12) { extra.reply_to_message_id = msg.message_id; extra.allow_sending_without_reply = true; }
      const sent = await sendAs(bot, chatId, replyText, extra);
      console.log(`[kavan${bot.idx}] -> ${name}: "${replyText.slice(0, 60)}" sent=${sent.ok}`);
      if (sent.ok) {
        db.pushOwnReply(chatId, replyText);
        st.push({ name: 'کاوان', uid: 0, text: replyText.slice(0, 150), t: Date.now() });
        if (st.length > 30) st.shift();
        store.markDirty();
        rel.bump(chatId, from.id, 'int', force ? 2 : 1, force ? 'تعامل مستقیم' : 'گفتگوی خودجوش');
      }
    } catch (e) { console.error('reply error:', e.message); }
  }, delayMs());
}

async function handlePrivate(msg, bot) {
  const from = msg.from || {};
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (from.id === OWNER_ID) { await sendPanel(bot, chatId, msg.message_id); return; }
  // strangers get a real (memory-keeping) chat, not a canned panel
  if (!text) return;
  db.observeMessage(chatId, from.id, from.first_name || '؟', from.username, text);
  const incoming = { uid: from.id, name: from.first_name || 'شما', text };
  const sys = persona.buildSystem(chatId, { senderUid: from.id, senderName: incoming.name, force: true });
  const userCtx = persona.buildContext(chatId, incoming, { includeRoster: false }) + '\n\n(گفتگوی خصوصی — جواب کوتاه و طبیعی بده.)';
  let raw = null;
  try { raw = await brain.brainChat([{ role: 'system', content: sys }, { role: 'user', content: userCtx }]); } catch (_) {}
  const replyText = await polish(chatId, raw, { force: true, fallbacks: MENTION_FALLBACKS, rawText: text });
  await sendAs(bot, chatId, replyText || 'سلام 👀 بفرما');
  db.pushOwnReply(chatId, replyText || 'سلام 👀 بفرما');
}

async function handleCallback(cb, bot) {
  await call(bot.token, 'answerCallbackQuery', { callback_query_id: cb.id });
  const chatId = cb.message?.chat?.id;
  if (!chatId) return;
  if (cb.data === 'panel_refresh') await sendPanel(bot, chatId);
  else if (cb.data === 'panel_admins') {
    const admins = (await call(bot.token, 'getChatAdministrators', { chat_id: chatId })).result || [];
    const lines = admins.map(a => {
      const u = a.user || {};
      const nm = (u.is_bot && u.first_name === 'Group') ? 'Group' : (u.first_name || '?');
      const un = u.username ? ` (@${u.username})` : '';
      return (a.status === 'creator' ? '👑 سازنده' : '🛡 ادمین') + `: ${nm}${un}`;
    });
    await call(bot.token, 'sendMessage', { chat_id: chatId, text: lines.join('\n') || 'ادمینی پیدا نشد' });
  } else if (cb.data === 'panel_status') {
    const s = brain.status();
    await call(bot.token, 'sendMessage', { chat_id: chatId, text: `📡 کاوان آنلاینه 👀\n🧠 مغز: ${s.brain}\n📖 ${db.chatHistory(chatId).length} پیام تو حافظه\n🕒 ${new Date().toLocaleTimeString('fa-IR')}` });
  } else if (cb.data === 'panel_memory') {
    const s = db.stats();
    const st = store.status();
    await call(bot.token, 'sendMessage', { chat_id: chatId, text: `🧠 حافظه کاوان\n👥 ${s.users} کاربر | 🧠 ${s.memories} خاطره\n📅 ${s.events} رویداد | 📚 ${s.learned} اصطلاح\n☁️ سینک: ${st.backend}${st.lastError ? `\n⚠️ ${st.lastError}` : ''}` });
  }
}

// --- server -----------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/', (_req, res) => res.send(`کاوان v4 آنلاینه ✅ (${BOTS.length} اکانت)`));

app.get('/debug', (req, res) => {
  const chats = new Map();
  try {
    const lines = fs.readFileSync(ARCHIVE, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const u = JSON.parse(line);
        const m = u.message || u.my_chat_member?.chat || u.callback_query?.message;
        if (!m?.chat || m.chat.type === 'private') continue;
        const c = m.chat;
        const rec = chats.get(c.id) || { id: c.id, title: c.title || c.username || '?', type: c.type, bots: new Set(), count: 0, last: null };
        if (u.bot) rec.bots.add(u.bot);
        rec.count++;
        rec.last = u.message?.date || rec.last;
        chats.set(c.id, rec);
      } catch (_) {}
    }
  } catch (_) {}
  const out = [...chats.values()].map(c => ({ ...c, bots: [...c.bots], last: c.last ? new Date(c.last * 1000).toISOString() : null }));
  const payload = { accounts: BOTS.map(b => ({ username: '@' + b.username, id: b.id })), chatsSeen: out, storage: store.status(), memory: db.stats() };
  if (req.query.tail) {
    try {
      const lines = fs.readFileSync(ARCHIVE, 'utf-8').trim().split('\n').filter(Boolean);
      payload.lastUpdates = lines.slice(-Number(req.query.tail)).map(l => { try { const u = JSON.parse(l); const m = u.message || {}; return { bot: u.bot, chat: m.chat?.title || m.chat?.id, from: m.from?.first_name || m.author_signature, uid: m.from?.id, text: (m.text || '').slice(0, 80), type: u.callback_query ? 'callback' : (m.chat?.type) }; } catch (_) { return null; } }).filter(Boolean);
    } catch (_) {}
  }
  res.json(payload);
});

app.get('/health', (_req, res) => res.json({
  version: '4.0.0',
  bots: BOTS.map(b => ({ idx: b.idx, username: b.username, id: b.id })),
  ...brain.status(),
  storage: store.status(),
  memory: db.stats(),
  romance: rel.romanceState(),
  dryrun: DRY,
}));

app.get('/nettest', async (_req, res) => res.json(await brain.nettest()));

const routeFor = idx => (req, res) => {
  res.sendStatus(200);
  const update = req.body || {};
  const bot = BOTS[Math.min(idx, BOTS.length - 1)];
  archive(bot, update);
  if (update.update_id && !updateDedupe(update.update_id)) return; // §9.3 no duplicate processing
  (async () => {
    try {
      if (update.callback_query) await handleCallback(update.callback_query, bot);
      else if (update.message) {
        const msg = update.message;
        const t = msg.chat?.type;
        if (t === 'group' || t === 'supergroup') await handleGroup(msg, bot);
        else if (t === 'private') await handlePrivate(msg, bot);
      }
    } catch (e) { console.error('handler error:', e.message); }
  })();
};
app.post('/webhook', routeFor(PRIMARY));
app.post('/webhook2', routeFor(1));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`kavan v4.0 on :${PORT} | accounts: ${BOTS.map(b => '@' + b.username).join(', ')} | storage: ${store.status().backend}`);
});
