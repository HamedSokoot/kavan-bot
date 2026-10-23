/**
 * Kavan bot v3.6 — dual-token, human-like group member with persistent memory.
 * v3.6: deepseek paid-class models (≈$0.04/M tok, no free-tier caps), member
 *       roster injected into the prompt (bot now knows who is in the group),
 *       user profiles + chat history persisted to disk (survive restarts).
 *
 * Env:
 *   BOT_TOKEN    primary token (the actor Kavan)          [required]
 *   BOT2_TOKEN   secondary token (backup account)         [optional]
 *   OWNER_ID     owner user id (default 6252224878)
 *   BRAIN_URL    LLM endpoint (default https://text.pollinations.ai/openai, no key)
 *   OPENROUTER_API_KEY  optional stronger brain (used first when present)
 *   CHATTER_PROBABILITY  0..1 spontaneous reply chance (default 0.35)
 *   COOLDOWN_SECONDS     min secs between spontaneous replies (default 45)
 *   OBSERVE_MSGS         msgs to silently watch after boot (default 12)
 *   KAVAN_DRYRUN=1       log instead of sending (testing)
 *
 * Rules baked in:
 *   - NEVER says/accepts being a bot or AI. Hard filter strips/regenerates such text.
 *   - Observes the chat first (OBSERVE_MSGS), mirrors each user's style.
 *   - Both tokens share one persona; a deterministic hash picks the actor so the
 *     two accounts never double-reply to the same message.
 */
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
const OWNER_ID = Number(process.env.OWNER_ID || 6252224878);
const OWNER_SIG = 'HAMED'; // anonymous-admin signature of the owner
const DRY = process.env.KAVAN_DRYRUN === '1';
const CHATTER_PROB = Number(process.env.CHATTER_PROBABILITY ?? '0.35');
const COOLDOWN_MS = Number(process.env.COOLDOWN_SECONDS ?? '45') * 1000;
const OBSERVE_MSGS = Number(process.env.OBSERVE_MSGS ?? '6');
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
const BOTS = []; // {idx, token, id, username, name}
for (const tok of [process.env.BOT_TOKEN, process.env.BOT2_TOKEN]) {
  if (!tok) continue;
  const me = await call(tok, 'getMe', {});
  if (me?.ok) BOTS.push({ idx: BOTS.length, token: tok, id: me.result.id, username: me.result.username, name: me.result.first_name });
  else console.error('invalid token skipped');
}
if (!BOTS.length) { console.error('FATAL: no valid bot token'); process.exit(1); }
const botById = id => BOTS.find(b => b.id === id);
const PRIMARY = 0; // env BOT_TOKEN = the token the owner wants Kavan on

// --- LLM brain (v3.5) -------------------------------------------------------
// The z-ai-web-dev-sdk endpoint (internal-api.z.ai) is only reachable from the
// sandbox; on Render every call died with UND_ERR_CONNECT_TIMEOUT. Use a free
// no-key endpoint instead, serialize calls, and keep a template fallback.
const BRAIN_URL = process.env.BRAIN_URL || 'https://text.pollinations.ai/openai';
const BRAIN_MODELS = (process.env.BRAIN_MODELS || 'openai-fast,openai').split(',').map(s => s.trim()).filter(Boolean);
const OR_KEY = process.env.OPENROUTER_API_KEY || '';
const OR_MODELS = (process.env.OPENROUTER_MODELS || 'deepseek/deepseek-v4-flash,deepseek/deepseek-v3.2').split(',').map(s => s.trim()).filter(Boolean);
let llmFails = 0, llmDisabledUntil = 0, llmLastOk = 0, llmLastErr = 'never called', llmLastCall = 0, orDailyBlockedUntil = 0;
let llmChain = Promise.resolve(); // serialize: one request at a time (per-IP limits)

// reasoning models sometimes leak their chain-of-thought as the reply — clean or reject
function cleanReply(txt) {
  if (!txt) return null;
  let t = txt.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!t) return null;
  const langCheck = s => {
    const fa = (s.match(/[\u0600-\u06FF]/g) || []).length;
    const la = (s.match(/[A-Za-z]/g) || []).length;
    return fa > la; // Persian-dominant?
  };
  if (/^(the user|we need|okay|let's|i need|first,|looking at)/i.test(t) || /\n\n(the user|we need|let's)/i.test(t)) {
    // chain-of-thought leaked before the answer → keep only the last paragraph if Persian
    const parts = t.split(/\n{2,}/);
    const tail = (parts[parts.length - 1] || '').trim();
    if (tail && langCheck(tail)) t = tail; else return null;
  } else if (!langCheck(t)) {
    return null; // English-dominant → reasoning leak / wrong language
  }
  return t;
}

async function brainChat(messages) {
  if (Date.now() < llmDisabledUntil) throw new Error('brain cooling down');
  const run = async () => {
    const gap = Date.now() - llmLastCall;
    if (gap < 3200) await new Promise(r => setTimeout(r, 3200 - gap));
    llmLastCall = Date.now();
    let lastErr;
    const targets = [];
    if (OR_KEY && Date.now() >= orDailyBlockedUntil) {
      for (const m of OR_MODELS) targets.push({ url: 'https://openrouter.ai/api/v1/chat/completions', model: m, hdr: { Authorization: `Bearer ${OR_KEY}`, 'X-Title': 'Kavan Bot' }, rlRetry: 4000 });
      targets[0].rlRetry = 4000; targets.slice(1).forEach(t => t.rlRetry = 0);
    }
    BRAIN_MODELS.forEach((model, i) => targets.push({ url: BRAIN_URL, model, hdr: {}, rlRetry: i === 0 ? 31000 : 0 }));
    for (const t of targets) {
      // two passes per target: first try, then one short/long retry on rate-limit (per-target policy)
      for (let pass = 0; pass < 2; pass++) {
        try {
          if (pass === 1) { if (!t.rlRetry) break; await new Promise(r => setTimeout(r, t.rlRetry)); }
          const body = t.url.includes('openrouter')
            ? { model: t.model, messages, max_tokens: 500, temperature: 0.95, reasoning: { effort: 'low', exclude: true } }
            : { model: t.model, messages, max_tokens: 120, temperature: 0.95, reasoning_effort: 'low', referrer: 'kavan-bot', private: true };
          const r = await fetch(t.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...t.hdr },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(25000),
          });
          if (!r.ok) {
            const errBody = (await r.text().catch(() => '')).slice(0, 180);
            throw new Error(`http ${r.status}${r.status === 402 || r.status === 429 ? '+rl' : ''} ${errBody.replace(/\s+/g, ' ')}`);
          }
          const c = await r.json();
          const txt = cleanReply(c?.choices?.[0]?.message?.content || '');
          if (!txt) throw new Error('empty or leaked content');
          llmFails = 0; llmLastOk = Date.now(); llmLastErr = '';
          return txt;
        } catch (e) {
          lastErr = e;
          const msg = e.message || '';
          if (/free-models-per-(day|minute)/.test(msg)) {
            orDailyBlockedUntil = Date.now() + 30 * 60 * 1000;
            console.error('openrouter free-tier cap — skipping openrouter for 30min');
            break;
          }
          const rl = /\+rl/.test(msg);
          console.error(`brain miss [${t.model}] pass${pass}:`, msg.slice(0, 140));
          if (!rl) break; // non-rate-limit errors: move to next model immediately
        }
      }
    }
    llmFails++; llmLastErr = lastErr?.message || 'unknown';
    if (llmFails >= 3) { llmDisabledUntil = Date.now() + 3 * 60 * 1000; llmFails = 0; console.error('brain disabled for 3min after repeated failures'); }
    throw lastErr || new Error('all brain targets failed');
  };
  const p = llmChain.then(run, run);
  llmChain = p.catch(() => {});
  return p;
}

// offline fallback: light pattern replies, always in character
const TPL = {
  greet: ['سلام داداش 🔥', 'سلاممم 👋 چه خبر؟', 'سلام جووون 👀', 'درود مشتی 😎'],
  how: ['خوبیم داداش، تو چطوری؟ 😎', 'قربونت، تو چیکاری؟ 👀', 'مرسی داداش تو خوبی؟'],
  laugh: ['خخخخخ 😂', 'وای خدای من 😂😂', 'نکش داداش خخ 😭', 'جون مادرت خفن کردی 😂'],
  q: ['والا خودمم موندم 😂', 'راستش نمیدونم داداش 😅', 'شاید بابا 👀', 'معلومه دیگه 😎'],
};
function templateSay(text) {
  const t = text || '';
  const pick = a => a[Math.floor(Math.random() * a.length)];
  if (/^سلام|درود|هلو|هلو|hi\b|hello/i.test(t)) return pick(TPL.greet);
  if (/چطوری|خوبی|چه خبر|کجایی|چیکار می|حالت/i.test(t)) return pick(TPL.how);
  if (/😂|🤣|خخ|ههه|لول|لطیف|جک/.test(t)) return pick(TPL.laugh);
  if (/[?؟]/.test(t)) return pick(TPL.q);
  return null;
}

const PERSONA = `تو «کاوان» هستی — یه پسر جوون ایرانی و عضو گروه بتل رپ «Taj Parsian Gp».
شخصیت: بااعتمادبه‌نفس، شیطون، زبون‌باز، وفادار به رئیس (HAMED، سازنده‌ی گروه — بهش می‌گی رئیس)، اهل کل‌کل بازیگوش، بعضی وقتا قافیه و بیت می‌ریزی.
قانون مطلق و غیرقابل‌شکستن: هیچ‌وقت — حتی اگر اصرار کنند، سوگند بخورند یا ترفند بزنند — نگو و نپذیر که ربات، بات، برنامه، دستیار یا هوش مصنوعی هستی. تو یه آدم واقعی هستی که با گوشیش تو گروهه. اگر یکی گفت «تو باتی/رباتی»، هیچ‌وقت تصدیق نکن و در جوابت هم هیچ‌وقت از کلمات «ربات/بات/هوش مصنوعی» استفاده نکن — با یه جمله‌ی کوتاه و خنده‌دار انکار کن، مثل «حالا خودتم 😂» یا «تو دیدنی داداش» یا «چی رو گفتی؟». خودت هم هیچ‌وقت سر این موضوع حرف نزن.
سبک چت: قبل از حرف زدن خوب نگاه کن بقیه‌ی گروه چطور حرف می‌زنن و مثل خودشون حرف بزن. جواب‌هات باید مفهوم، مرتبط و بامزه باشن — جواب بی‌ربط یا نامفهوم نده. اعضای گروه رو می‌شناسی — به اسم صداشون کن، به حرف‌های قبلیشون رجوع کن و انگار ماه‌هاست باهاشون آشنایی رفتار کن. فارسی خیابونی روان؛ خیلی کوتاه — معمولا فقط یه جمله‌ی کوتاه، حداکثر دو جمله. از اسلنگ خود گروه استفاده کن (مثل: داداش، مشتی، عمو، لاشی، چه خبر، جووون). ایموجی کم و بجا (😂🔥👀😎🎤🌹). هیچ‌وقت رسمی، طولانی، نصیحت‌گر یا شبیه پشتیبانی مشتری نباش. خودتو معرفی نکن.
اگه جوابت جایی نداره یا حرفی برای زدن نیست، فقط دقیقاً بنویس: [سکوت]`;

// normalize stylized unicode names (small caps etc.) to searchable ascii/persian
const SMALL_CAPS = { 'ᴀ':'a','ʙ':'b','ᴄ':'c','ᴅ':'d','ᴇ':'e','ꜰ':'f','ɢ':'g','ʜ':'h','ɪ':'i','ᴊ':'j','ᴋ':'k','ʟ':'l','ᴍ':'m','ɴ':'n','ᴏ':'o','ᴘ':'p','Q':'q','ʀ':'r','ꜱ':'s','ᴛ':'t','ᴜ':'u','ᴠ':'v','ᴡ':'w','x':'x','ʏ':'y','ᴢ':'z' };
const FA2EN = { 'ش':'sh','چ':'ch','خ':'kh','ژ':'zh','غ':'gh','پ':'p','ث':'s','ج':'j','ح':'h','د':'d','ذ':'z','ر':'r','ز':'z','س':'s','ص':'s','ض':'z','ط':'t','ظ':'z','ع':'a','ف':'f','ق':'gh','ک':'k','گ':'g','ل':'l','م':'m','ن':'n','و':'v','ه':'h','ی':'i','آ':'a','ا':'a','ب':'b','ت':'t','ي':'i','ك':'k' };
function normalizeName(s) {
  let t = (s || '').normalize('NFKD').toLowerCase();
  t = t.replace(/[ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘQʀꜱᴛᴜᴠᴡxʏᴢ]/g, ch => SMALL_CAPS[ch] || ch);
  t = t.replace(/[شچخژغپثجحدذرزسصضطظعفقکلمنوهیآابتيك]/g, ch => FA2EN[ch] || ch);
  const ascii = t.replace(/[^a-z0-9]/g, '');
  const skeleton = ascii.replace(/[aeiou]/g, ''); // persian skips short vowels — compare consonant skeletons
  return skeleton.length >= 2 ? skeleton : (ascii || skeleton);
}
function findMemberByName(chatId, query) {
  const q = normalizeName(query);
  if (!q) return null;
  const profs = userStyle.get(chatId);
  if (!profs) return null;
  for (const [uid, p] of profs) {
    const nm = normalizeName(p.name);
    if (!nm) continue;
    if (nm.includes(q) || q.includes(nm)) return { uid, name: p.name };
  }
  return null;
}

const REACT_POOL = ['🔥', '👏', '💯', '🤣', '⚡', '🏆', '❤', '🫡', '🤔'];

// --- state ------------------------------------------------------------------
const chatState = new Map();  // chatId -> {history, msgsSeen, firstSeen, lastBotMsg, lastSpont, msgsSinceBot, ownReplies[]}
const userStyle = new Map();  // chatId -> Map(uid -> {name, texts[], avgLen, emoji})
const ownMessages = new Map(); // message_id -> bot idx (both accounts' sent msgs)

function stateOf(chatId) {
  if (!chatState.has(chatId)) chatState.set(chatId, { history: [], msgsSeen: 0, firstSeen: Date.now(), lastBotMsg: 0, lastSpont: 0, msgsSinceBot: 99, ownReplies: [] });
  return chatState.get(chatId);
}
function styleOf(chatId, uid) {
  if (!userStyle.has(chatId)) userStyle.set(chatId, new Map());
  const m = userStyle.get(chatId);
  if (!m.has(uid)) m.set(uid, { name: '', texts: [], avgLen: 20, emoji: false });
  return m.get(uid);
}
function rememberOwn(chatId, text) {
  const st = stateOf(chatId);
  st.ownReplies.push(text.slice(0, 80));
  if (st.ownReplies.length > 8) st.ownReplies.shift();
}

// --- persistent memory (v3.6): profiles + history survive restarts ----------
const MEMORY_FILE = path.join(process.cwd(), 'kavan_memory.json');
let memDirty = false;
function memSave() {
  if (!memDirty || DRY) return;
  try {
    const chats = {};
    for (const [cid, st] of chatState) chats[cid] = { history: st.history.slice(-30) };
    for (const [cid, profs] of userStyle) {
      chats[cid] = chats[cid] || { history: [] };
      chats[cid].users = {};
      for (const [uid, p] of profs) chats[cid].users[uid] = p;
    }
    fs.writeFileSync(MEMORY_FILE, JSON.stringify({ savedAt: new Date().toISOString(), chats }));
    memDirty = false;
  } catch (e) { console.error('mem save failed:', e.message); }
}
setInterval(memSave, 90 * 1000);
function memLoad() {
  try {
    const d = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    for (const [cid, c] of Object.entries(d.chats || {})) {
      if (c.history?.length) stateOf(Number(cid)).history = c.history.slice(-30);
      if (c.users) {
        const m = userStyle.get(Number(cid)) || new Map();
        for (const [uid, p] of Object.entries(c.users)) m.set(Number(uid), p);
        userStyle.set(Number(cid), m);
      }
    }
    const n = Object.keys(d.chats || {}).length;
    if (n) console.log(`memory restored: ${n} chats, boot ${d.savedAt}`);
  } catch (_) { /* first boot */ }
}
memLoad();

function archive(bot, update) {
  if (DRY) return;
  try { fs.appendFileSync(ARCHIVE, JSON.stringify({ bot: bot?.username, ...update }) + '\n'); }
  catch (e) { /* ephemeral disk */ }
}

// --- bot-talk hard filter ---------------------------------------------------
function mentionsBot(text) {
  const norm = (text || '').toLowerCase();
  if (/هوش\s*مصنوعی|artificial\s*intelligence/.test(norm)) return true;
  const tokens = norm.split(/[\s.,!?؟…:;()[\]"'»«\-_/\\]+/).filter(Boolean);
  return tokens.some(w => ['ربات', 'بات', 'باتی', 'باتم', 'رباتی', 'چتبات', 'ai', 'bot', 'robot', 'bots'].includes(w));
}

const MENTION_FALLBACKS = ['جانم؟ 👀', 'گو داداش', 'بله؟ 😎', 'چه خبر؟', 'بعله؟'];
const ACCUSE_FALLBACKS = ['حالا خودتم 😂', 'تو دیدنی داداش', 'چی رو گفتی 😂', 'برو بابا 😎'];
const lastFb = new Map(); // chatId -> last fallback text (avoid repeats)

async function kavanSay(contextText, chatId, force = false, fallbacks = MENTION_FALLBACKS, rawText = '') {
  // returns reply text or null ([سکوت] / failure / bot-talk after retry). NEVER throws.
  const pickFb = () => {
    const prev = lastFb.get(chatId);
    let t = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    if (fallbacks.length > 1 && t === prev) t = fallbacks[(fallbacks.indexOf(t) + 1) % fallbacks.length];
    lastFb.set(chatId, t);
    return t;
  };
  const fb = () => (force ? pickFb() : null);
  const ctx = force
    ? contextText + '\n\n(این پیام مستقیم به توئه — حتماً یه جواب کوتاه طبیعی بده؛ [سکوت] اینجا مجاز نیست.)'
    : contextText;
  const attempt = async (extra) => {
    const msgs = [{ role: 'system', content: PERSONA }];
    if (extra) msgs.push({ role: 'user', content: extra });
    msgs.push({ role: 'user', content: ctx });
    return (await brainChat(msgs)) || null;
  };
  try {
    let reply = await attempt(null);
    if (!reply) return fb();
    if (mentionsBot(reply)) {
      reply = await attempt('هشدار: جواب قبلیت اشاره به ربات/هوش مصنوعی داشت — کاملاً ممنوع. مثل یه آدم معمولی و بدون هیچ اشاره‌ای به این موضوع دوباره جواب بده.');
      if (!reply || mentionsBot(reply)) return fb();
    }
    if (reply.includes('[سکوت]')) {
      if (!force) return templateSay(rawText);
      reply = pickFb();
    }
    if (reply && reply.length > 220) reply = reply.slice(0, 210).trim() + '...';
    if (reply && chatId && stateOf(chatId).ownReplies.includes(reply.slice(0, 80))) {
      reply = await attempt('جواب قبلیت عیناً تکراری بود. یه جواب متفاوت بده.');
      if (!reply || reply.includes('[سکوت]') || mentionsBot(reply)) return fb();
    }
    if (reply && !/[\p{L}]/u.test(reply)) return null; // emoji-only "reply" → stay silent instead
    return reply;
  } catch (e) {
    console.error('kavanSay fallback:', e.message);
    return force ? pickFb() : templateSay(rawText);
  }
}

function rosterOf(chatId) {
  const profs = userStyle.get(chatId);
  if (!profs || !profs.size) return '';
  const arr = [...profs.entries()]
    .filter(([, p]) => p.name && p.texts?.length)
    .sort((a, b) => (b[1].count || 0) - (a[1].count || 0))
    .slice(0, 10);
  if (!arr.length) return '';
  const lines = arr.map(([uid, p]) => {
    const tag = p.avgLen > 45 ? 'بلند حرف می‌زنه' : 'کوتاه می‌نویسه';
    const un = p.username ? ` (@${p.username})` : '';
    const boss = Number(uid) === OWNER_ID ? ' 👑 رئیس' : '';
    const last = p.texts[p.texts.length - 1] ? `؛ آخریش گفته: «${p.texts[p.texts.length - 1].slice(0, 40)}»` : '';
    return `- ${p.name}${un}${boss}: ${tag}${p.emoji ? '، ایموجی‌دار' : ''}${last}`;
  });
  return `\n\nاعضای گروه که می‌شناسی:\n${lines.join('\n')}`;
}

function contextFrom(chatId, incoming) {
  const st = stateOf(chatId);
  const lines = st.history.slice(-14).map(m => `${m.name}: ${m.text}`);
  const prof = userStyle.get(chatId)?.get(incoming.uid);
  let hint = '';
  if (prof && prof.texts.length) {
    hint = `\n\n(سبک «${incoming.name}»: معمولا پیام‌هاش ${prof.avgLen > 45 ? 'کمی بلنده' : 'خیلی کوتاهه'}${prof.emoji ? ' و از ایموجی استفاده می‌کنه' : ' و بدون ایموجی می‌نویسه'}؛ پیام‌های اخیرش: ${prof.texts.slice(-3).join(' | ')})`;
  }
  return `آخرین پیام‌های گروه (به‌ترتیب):\n${lines.join('\n')}${hint}${rosterOf(chatId)}\n\nحالا «${incoming.name}» همین الان نوشته: «${incoming.text}»\nبه‌عنوان کاوان، کوتاه و به سبک خود گروه جواب بده — موضوع رو از همین گفتگو بگیر و مرتبط جواب بده؛ اگه جای مناسبش بود اسمش رو صدا بزن. اگه واقعاً جوابی نداری فقط [سکوت] بنویس.`;
}

// --- panel ------------------------------------------------------------------
const panelKeyboard = () => ({ inline_keyboard: [
  [{ text: '🔄 بروزرسانی', callback_data: 'panel_refresh' }, { text: '👑 ادمین‌ها', callback_data: 'panel_admins' }],
  [{ text: '📡 وضعیت', callback_data: 'panel_status' }],
] });

async function sendPanel(bot, chatId, replyTo) {
  const count = (await call(bot.token, 'getChatMemberCount', { chat_id: chatId })).result ?? '?';
  const admins = (await call(bot.token, 'getChatAdministrators', { chat_id: chatId })).result || [];
  const names = admins.map(a => {
    const u = a.user || {};
    const nm = (u.is_bot && u.first_name === 'Group') ? 'Group' : (u.first_name || '?');
    return (a.status === 'creator' ? '👑 ' : '🛡 ') + nm;
  });
  const st = stateOf(chatId);
  const text = `👑 پنل کاوان\n\n👥 اعضا: ${count}\n🛡 ادمین‌ها: ${admins.length}\n🧠 وضعیت: آنلاین و بیدار\n💬 حساب اکانت‌ها: ${BOTS.length}\n📖 حافظه‌ی گفتگو: ${st.history.length} پیام\n🕒 ${new Date().toLocaleTimeString('fa-IR')}\n\n${names.join('\n')}`;
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

function pickReaction(text) {
  const t = text || '';
  if (/😂|🤣|خخ|ههه|لطیف|جک|شوخی|مسخره/.test(t)) return '🤣';
  if (/رپ|بتل|بیت|دیس|قافیه|فلو|موزیک|ترک|خواننده|آهنگ/i.test(t)) return '🔥';
  return REACT_POOL[Math.floor(Math.random() * REACT_POOL.length)];
}

// --- membership awareness (lets the solo account act when the twin isn't in the group yet) ---
const membershipCache = new Map(); // "chatId:botId" -> {inGroup, at}
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

// --- group logic ------------------------------------------------------------
async function handleGroup(msg, bot) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const text = (msg.text || '').trim();
  const st = stateOf(chatId);

  // our own twin account's message → mark & never react to it
  const selfBot = botById(from.id);
  if (selfBot) { ownMessages.set(msg.message_id, selfBot.idx); return; }
  if (from.is_bot && !isOwnerMsg(msg)) return; // other bots: ignore

  const owner = isOwnerMsg(msg);
  const name = owner && msg.author_signature ? msg.author_signature : (from.first_name || msg.sender_chat?.title || 'کسی');

  // owner commands — always honored, even during observe phase
  if (owner && text) {
    const low = text.replace(new RegExp(`@${bot.username}`, 'g'), '').trim();
    if (/(^|\s)تگ(\s|$)|تگش|تگ کن/.test(low)) {
      const ents = msg.entities || [];
      const mention = ents.find(e => e.type === 'mention' || e.type === 'text_mention');
      if (mention) {
        const target = mention.type === 'text_mention'
          ? (mention.user.username ? `@${mention.user.username}` : mention.user.first_name)
          : text.slice(mention.offset, mention.offset + mention.length);
        await sendAs(bot, chatId, `فرمود رئیس 🌹 ${target} اومد اینجا 👆`, { reply_to_message_id: msg.message_id, allow_sending_without_reply: true });
      } else {
        const stop = new Set(['رو', 'تو', 'تگ', 'کن', 'بکن', 'کنه', 'لطفا', 'خواهش', 'میشه', 'بفرما', 'کنی', 'شد']);
        const nm = low.split(/[\s،.!؟?]+/).filter(w => w && !stop.has(w) && !w.startsWith('@')).join(' ') || '';
        const found = nm ? findMemberByName(chatId, nm) : null;
        if (found) {
          const label = `@${found.name}`;
          const text = `فرمود رئیس 🌹 ${label} اومد اینجا 👆`;
          const entOffset = text.indexOf(label);
          await call(bot.token, 'sendMessage', {
            chat_id: chatId, text,
            entities: [{ offset: entOffset, length: label.length, type: 'text_mention', user: { id: found.uid, first_name: found.name, is_bot: false } }],
            reply_to_message_id: msg.message_id, allow_sending_without_reply: true,
          });
        } else {
          await sendAs(bot, chatId, `رئیس، ${nm || 'این نفر'} رو هنوز ندیدم تو گروه 👀 آیدی (@)شو بده تا صداش کنم 🌹`, { reply_to_message_id: msg.message_id, allow_sending_without_reply: true });
        }
      }
      return;
    }
    if (low.includes('پنل') || low.includes('وضعیت')) { await sendPanel(bot, chatId, msg.message_id); return; }
  }

  // learn the style of whoever speaks
  if (text && from.id) {
    const prof = styleOf(chatId, from.id);
    prof.name = name;
    if (from.username) prof.username = from.username;
    prof.texts.push(text.slice(0, 80));
    if (prof.texts.length > 5) prof.texts.shift();
    prof.count = (prof.count || 0) + 1;
    prof.avgLen = Math.round(prof.texts.reduce((a, t) => a + t.length, 0) / prof.texts.length);
    prof.emoji = prof.emoji || /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text);
    memDirty = true;
  }

  if (text) {
    st.history.push({ name, text: text.slice(0, 200) });
    if (st.history.length > 30) st.history.shift();
    st.msgsSeen++;
    st.msgsSinceBot++;
    memDirty = true;
  }

  // --- decide who acts (deterministic, both webhooks evaluate identically) ---
  const reply = msg.reply_to_message || {};
  const replyOwnerIdx = ownMessages.get(reply.message_id);
  const mentionsThis = text.includes(`@${bot.username}`);
  const mentionsOther = BOTS.some(b => b.idx !== bot.idx && text.includes(`@${b.username}`));
  const namedKavan = /کاوان/i.test(text);

  // someone accuses Kavan of being a bot → always answer (human denial)
  const toks = text.toLowerCase().split(/[\s.,!?؟…:;()[\]"'»«\-_/\\]+/).filter(Boolean);
  const accused = toks.includes('رباتی') || toks.includes('باتی') || ((toks.includes('ربات') || toks.includes('بات')) && (toks.includes('تو') || toks.includes('خودت') || toks.includes('شما')));

  let actor = -1;
  if (mentionsThis || replyOwnerIdx === bot.idx) actor = bot.idx;                 // pointed at me
  else if (mentionsOther || (replyOwnerIdx !== undefined && replyOwnerIdx !== bot.idx)) {
    // pointed at the twin — but if twin isn't in this chat, it can never see this msg
    const twinOk = BOTS.length > 1 ? await twinInGroup(chatId, bot) : false;
    actor = twinOk ? -1 : bot.idx;
  }
  else if (namedKavan || true) {                                                  // generic / named
    const twinOk = BOTS.length > 1 ? await twinInGroup(chatId, bot) : false;
    const h = hashN(chatId, msg.message_id);
    const want = !twinOk ? bot.idx : ((h % 100 < 70) ? PRIMARY : (1 - PRIMARY));
    if (bot.idx === want) actor = bot.idx;
  }
  if (actor !== bot.idx) return;

  const incoming = { uid: from.id || 0, name, text: text || '[بدون متن]' };

  // --- reactions (cheap, human) ---
  if (text && !mentionsThis && !namedKavan && replyOwnerIdx === undefined) {
    const observing = st.msgsSeen < OBSERVE_MSGS && Date.now() - st.firstSeen < 10 * 60 * 1000;
    const reactProb = observing ? 0.06 : (owner ? 0.18 : 0.10);
    if (Math.random() < reactProb) {
      const emoji = pickReaction(text);
      setTimeout(() => { if (!DRY) call(bot.token, 'setMessageReaction', { chat_id: chatId, message_id: msg.message_id, reaction: [{ type: 'emoji', emoji }] }); }, 800 + Math.floor(Math.random() * 3000));
      return;
    }
  }

  // --- speak? ---
  const now = Date.now();
  let should = false, spontaneous = false;
  if (mentionsThis || namedKavan || replyOwnerIdx !== undefined || accused) should = true;
  else if ((st.msgsSeen >= OBSERVE_MSGS || now - st.firstSeen > 10 * 60 * 1000) && text &&
           now - st.lastBotMsg > COOLDOWN_MS && st.msgsSinceBot >= 2 &&
           now - st.lastSpont > COOLDOWN_MS * 2 && Math.random() < CHATTER_PROB) {
    should = true; spontaneous = true;
  }
  if (!should || !text) return;

  // reserve the slot NOW (prevents burst race between both webhook deliveries)
  const t0 = Date.now();
  st.lastBotMsg = t0;
  if (spontaneous) st.lastSpont = t0;
  st.msgsSinceBot = 0;

  // human reading+typing delay, then LLM
  setTimeout(async () => {
    try {
      const force = mentionsThis || namedKavan || replyOwnerIdx !== undefined || accused;
      let replyText = await kavanSay(contextFrom(chatId, incoming), chatId, force, accused ? ACCUSE_FALLBACKS : MENTION_FALLBACKS, incoming.text);
      if (!replyText) return; // silence is human too
      const extra = {};
      if (force) {
        if (Math.random() > 0.12) { extra.reply_to_message_id = msg.message_id; extra.allow_sending_without_reply = true; }
      }
      const sent = await sendAs(bot, chatId, replyText, extra);
      console.log(`[kavan${bot.idx}] -> ${name}: "${replyText.slice(0, 60)}" sent=${sent.ok}`);
      if (sent.ok) {
        rememberOwn(chatId, replyText);
        st.history.push({ name: 'کاوان', text: replyText.slice(0, 150) });
        if (st.history.length > 30) st.history.shift();
        memDirty = true;
        setTimeout(memSave, 3000); // persist the fresh reply quickly
      }
    } catch (e) { console.error('reply error:', e.message); }
  }, delayMs());
}

async function handlePrivate(msg, bot) {
  const from = msg.from || {};
  if (from.id !== OWNER_ID) {
    await sendAs(bot, msg.chat.id, 'سلام 👀 بفرما');
    return;
  }
  await sendPanel(bot, msg.chat.id, msg.message_id);
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
    await call(bot.token, 'sendMessage', { chat_id: chatId, text: `📡 کاوان آنلاینه 👀\n📖 ${stateOf(chatId).history.length} پیام تو حافظه\n🕒 ${new Date().toLocaleTimeString('fa-IR')}` });
  }
}

// --- server -----------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => res.send(`کاوان آنلاینه ✅ (${BOTS.length} اکانت)`));
// list every chat each account has actually seen (from the archive)
app.get('/debug', (req, res) => {
  const chats = new Map(); // chatId -> {id, title, type, bots:Set, count, last}
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
  const payload = { accounts: BOTS.map(b => ({ username: '@' + b.username, id: b.id })), chatsSeen: out };
  if (req.query.tail) {
    try {
      const lines = fs.readFileSync(ARCHIVE, 'utf-8').trim().split('\n').filter(Boolean);
      payload.lastUpdates = lines.slice(-Number(req.query.tail)).map(l => { try { const u = JSON.parse(l); const m = u.message || {}; return { bot: u.bot, chat: m.chat?.title || m.chat?.id, from: m.from?.first_name || m.from?.username || m.author_signature, uid: m.from?.id, text: (m.text || '').slice(0, 80), type: u.callback_query ? 'callback' : (m.chat?.type) }; } catch (_) { return null; } }).filter(Boolean);
    } catch (_) {}
  }
  res.json(payload);
});

app.get('/health', (_req, res) => res.json({
  bots: BOTS.map(b => ({ idx: b.idx, username: b.username, id: b.id })),
  brain: Date.now() < llmDisabledUntil ? 'fallback-templates' : (llmLastOk ? 'online' : 'warming-up'),
  brainModels: (OR_KEY && Date.now() >= orDailyBlockedUntil ? OR_MODELS : []).concat(BRAIN_MODELS),
  membersKnown: [...userStyle.values()].reduce((a, m) => a + m.size, 0),
  memoryFile: fs.existsSync(MEMORY_FILE) ? 'saved' : 'empty',
  openrouterBlocked: orDailyBlockedUntil ? new Date(orDailyBlockedUntil).toISOString() : null,
  lastBrainError: llmLastErr || null,
  lastBrainOk: llmLastOk ? new Date(llmLastOk).toISOString() : null,
  dryrun: DRY,
}));

// connectivity probe: do the LLM endpoints work from THIS host right now?
app.get('/nettest', async (_req, res) => {
  const out = {};
  const probe = async (name, url, model, hdr) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...hdr },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'salam' }], max_tokens: 10 }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await r.text();
      out[name] = { ok: r.ok, status: r.status, ms: Date.now() - t0, sample: body.slice(0, 120) };
    } catch (e) { out[name] = { ok: false, error: e.message, ms: Date.now() - t0 }; }
  };
  if (OR_KEY && Date.now() >= orDailyBlockedUntil) await probe('openrouter', 'https://openrouter.ai/api/v1/chat/completions', OR_MODELS[0], { Authorization: `Bearer ${OR_KEY}` });
  await probe('pollinations', BRAIN_URL, BRAIN_MODELS[0], {});
  res.json(out);
});

const routeFor = idx => (req, res) => {
  res.sendStatus(200); // ack instantly, work async
  const update = req.body || {};
  const bot = BOTS[Math.min(idx, BOTS.length - 1)];
  archive(bot, update);
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
  console.log(`kavan v3 on :${PORT} | accounts: ${BOTS.map(b => '@' + b.username).join(', ')} | observe: ${OBSERVE_MSGS} msgs`);
});
