// lib/intent-handlers.js — real tool executors behind detected intents (spec §10.3)
// Every handler returns: { reply|null, mention:{uid,name}|null, replyTo:msgId|null, events:[...] }
// Honest-unknown rule (§3.3/§1.6): if not found/unsure — say so, never invent.

import * as db from './db.js';
import * as rel from './relations.js';
import * as events from './events.js';
import * as persona from './persona.js';
import { brainChat, templateSay } from './brain.js';
import { normalize, matchKey, hardStop } from './normalizer.js';
import { OWNER_ID } from './env.js';

const t0 = () => Date.now();

function infoLine(u, chatId) {
  const bits = [];
  if (u.usernames[0]) bits.push(`آیدیش @${u.usernames[0]}`);
  if (u.names.length > 1) bits.push(`قبلا بهش می‌گفتن ${u.names.slice(1, 3).join('، ')}`);
  if (u.nicknames?.length) bits.push(`لقبش: ${u.nicknames.map(n => n.text).join('، ')}`);
  if (u.selfInfo?.length) bits.push(u.selfInfo.slice(-1)[0].text);
  if (u.groups[chatId]?.count) bits.push(`${u.groups[chatId].count} پیام دادیم دیدیمش`);
  return bits.join('، ');
}

// ---------------------------------------------------------------- search (§3)
function handleSearch(ctx, P) {
  const { chatId, msg } = ctx;
  const query = P.username ? `@${P.username}` : (P.person || ctx.text || '');
  const cands = db.searchPeople(chatId, query, { excludeUid: ctx.uid, limit: 5 });
  if (!cands.length) {
    return { reply: P.byDesc ? 'حتا با این توضیح پیداش نکردم داداش 😅 بیشتر بگو' : `${query} رو هنوز ندیدم تو گروه 👀 اگه آیدیش داره بگو`, replyTo: msg.message_id };
  }
  if (cands.length > 1 && cands[1].score >= 75) { // §3.3: two strong candidates → ask, never guess
    const list = cands.slice(0, 3).map(c => `«${c.name}»${c.username ? ` (@${c.username})` : ''} — ${c.reasons[0]}`).join('، ');
    return { reply: `${cands.length} تا پیدا کردم 😂 منظورت کدومه؟ ${list}`, replyTo: msg.message_id };
  }
  const c = cands[0];
  const u = db.getUser(c.uid);
  const extra = infoLine(u, chatId) || c.reasons[0];
  const mention = P.wantId || ctx.mentionsKavan ? { uid: c.uid, name: u.names[0] } : null;
  return { reply: `پیداش کردم 😎 ${c.name} — ${extra}`, mention, replyTo: msg.message_id };
}

// ---------------------------------------------------------------- person info
function handleAskInfo(ctx, P) {
  const cands = db.searchPeople(ctx.chatId, P.person, { limit: 3 });
  if (!cands.length) return { reply: `درباره «${P.person}» هنوز چیزی ندارم داداش 🤷`, replyTo: ctx.msg.message_id };
  const c = cands[0];
  const u = db.getUser(c.uid);
  const mem = db.searchMemories(ctx.chatId, { uid: c.uid, limit: 3 }).map(m => m.text);
  const facts = [infoLine(u, ctx.chatId), ...mem].filter(Boolean).slice(0, 3).join('، ');
  const r = rel.get(ctx.chatId, c.uid);
  return { reply: `${c.name}؟ ${facts || r.stage + 'ه، همین‌قدرا 😅'}`, replyTo: ctx.msg.message_id };
}

// ---------------------------------------------------------------- teaching (§7)
function handleTeachIdentity(ctx, P) {
  const { chatId, msg, uid, name } = ctx;
  // target person resolution: quoted @username / explicit name
  const val = String(P.value || '').trim();
  const unameMatch = val.match(/^@(\w{3,})$/);
  if (unameMatch) {
    // bind username to a person term (e.g. "این سبحانه: @sobhan")
    const cands = db.searchPeople(chatId, P.term, { limit: 1 });
    if (cands.length) {
      db.addNickname(cands[0].uid, P.term, uid);
      return { reply: `اوکی داداش، ثبت شد ✅ ${cands[0].name} = @${unameMatch[1]}`, replyTo: msg.message_id };
    }
    return { reply: `«${P.term}» رو هنوز تو گروه ندیدم که به @${unameMatch[1]} وصلش کنم 👀`, replyTo: msg.message_id };
  }
  // nickname binding: "به ایشون می‌گیم گرگ" — bind to last mentioned/replied user
  const target = ctx.replyFrom; // user being replied to, if any
  if (target?.id) {
    db.addNickname(target.id, val || P.term, uid);
    return { reply: `ثبت شد ✅ از این به بعد به ${target.first_name} می‌گم «${val || P.term}» 😎`, replyTo: msg.message_id };
  }
  return { reply: 'واضح نگف داداش 😂 کی رو به چی وصل کنم؟', replyTo: msg.message_id };
}

function handleTeachTerm(ctx, P) {
  const res = db.addLearned(ctx.chatId, { term: P.term, meaning: P.meaning, by: ctx.uid });
  if (!res.ok) return { reply: 'اینو بد گفتی داداش، بگو چی یعنی چی 😅', replyTo: ctx.msg.message_id };
  if (res.conflict) return { reply: `واژه «${P.term}» قبلا یه معنی دیگه یادم دادی 🤔 کدوم درسته؟ قدیمی: «${res.entry.meaning}»`, replyTo: ctx.msg.message_id };
  return { reply: `یاد گرفتم ✅ «${P.term}» یعنی ${P.meaning}، شدیم یه نفر 😎`, replyTo: ctx.msg.message_id };
}

function handleCorrect(ctx, P) {
  // correction: try to fix the most recent learned term the sender taught, else mark memory stale
  const learned = db.listLearned(ctx.chatId, 12).filter(l => l.by === Number(ctx.uid));
  const fixN = normalize(P.fix || '');
  if (learned.length && fixN) {
    const l = learned[0];
    db.addLearned(ctx.chatId, { term: l.term, meaning: fixN.slice(0, 120), by: ctx.uid, conf: 'reported' });
    return { reply: `درست کردم ✅ «${l.term}» از این به بعد یعنی ${fixN.slice(0, 60)}`, replyTo: ctx.msg.message_id };
  }
  return { reply: 'اوکی جواب گرفتم، دیگه اونطوری نمی‌گم 🤝', replyTo: ctx.msg.message_id };
}

// ---------------------------------------------------------------- memory & events (§2.3, §6)
function handleAskMemory(ctx, P) {
  const mem = db.searchMemories(ctx.chatId, { q: P.q || ctx.text, limit: 4 });
  const evs = db.eventsAbout(ctx.chatId, ctx.uid, 2);
  const all = [...mem.map(m => m.text), ...evs.map(e => e.summary)];
  if (!all.length) return { reply: 'والا از این قضیه چیزی یادم نیست داداش 😅', replyTo: ctx.msg.message_id };
  return { reply: `بله یادمه 😎 ${all[0]}`, replyTo: ctx.msg.message_id };
}

function handleEvents(ctx) {
  const lines = events.describe(ctx.chatId, 4);
  if (!lines.length) return { reply: 'اخیراً خبر خاصی نیست داداش، گروه خوابیده 😴', replyTo: ctx.msg.message_id };
  return { reply: `این خبرا 👀\n${lines.slice(0, 3).join('\n')}`, replyTo: ctx.msg.message_id };
}

function handleReport(ctx, P) {
  if (P.stats && ctx.isOwner) {
    const s = db.stats();
    return { reply: `📊 آمار حافظه:\n👥 ${s.users} کاربر\n🧠 ${s.memories} خاطره\n📅 ${s.events} رویداد\n📚 ${s.learned} اصطلاح\n❤️ ${s.romances}`, replyTo: ctx.msg.message_id };
  }
  return handleEvents(ctx);
}

// ---------------------------------------------------------------- diss (§11)
async function handleDis(ctx, P) {
  const { chatId, msg } = ctx;
  if (hardStop(ctx.text)) return { reply: 'این حد دیس از دستم برنمیاد داداش 😅 خط قرمزه.', replyTo: msg.message_id };
  let targetName = null, targetUid = null;
  if (P.person) {
    const cands = db.searchPeople(chatId, P.person, { limit: 2 });
    if (cands.length) { targetName = cands[0].name; targetUid = cands[0].uid; }
  }
  if (!targetName && ctx.replyFrom?.id) { targetName = ctx.replyFrom.first_name; targetUid = ctx.replyFrom.id; }
  if (!targetName) targetName = 'خودتو'; // dis the requester playfully
  const r = targetUid ? rel.get(chatId, targetUid) : null;
  const severity = r && r.conflict > 45 ? 3 : 2;
  const sys = persona.buildSystem(chatId, { senderUid: ctx.uid, senderName: ctx.name, force: true });
  const relLine = r ? rel.summarize(chatId, targetUid, targetName) : '';
  const userP = persona.buildDisPrompt(chatId, targetName, severity, relLine);
  let reply = null;
  try { reply = await brainChat([{ role: 'system', content: sys }, { role: 'user', content: userP }]); } catch (_) {}
  if (!reply) reply = `${targetName} عزیز، فلوی تو به خطای 404 می‌خوره 😂`;
  if (reply.includes('[سکوت]')) reply = `${targetName} جان، بیکارم نمی‌کشی 😂`;
  return { reply, replyTo: ctx.replyFrom?.message_id || msg.message_id, disTarget: targetUid };
}

// ---------------------------------------------------------------- privacy (§14)
function handleForget(ctx) {
  db.forgetUser(ctx.chatId, ctx.uid);
  return { reply: 'چشم داداش، هرچی ازت یاد داشتم ریختم دور 🗑️ از نو می‌شناسمت از این به بعد.', replyTo: ctx.msg.message_id };
}

// ---------------------------------------------------------------- about me
function handleAboutMe(ctx) {
  const u = db.getUser(ctx.uid);
  if (!u) return { reply: 'والا هنوز زیاد همدیگه رو ندیدیم داداش 😂 خودتم بگو', replyTo: ctx.msg.message_id };
  const r = rel.get(ctx.chatId, ctx.uid);
  const bits = [];
  if (u.names[0]) bits.push(`اسمش ${u.names[0]}ئه`);
  if (u.selfInfo?.length) bits.push(u.selfInfo.slice(-2).map(s => s.text).join('، '));
  if (u.groups[ctx.chatId]?.count) bits.push(`${u.groups[ctx.chatId].count} پیام باهات دیدم`);
  return { reply: `تو که خودتی داداش 😂 ${bits.join('، ') || 'هنوز خیلی ازت نمی‌دونم'} — رابطه‌مونم ${r.stage}ئه`, replyTo: ctx.msg.message_id };
}

// ---------------------------------------------------------------- romance (§12)
function handleRomance(ctx, P) {
  const { chatId, uid } = ctx;
  const target = ctx.replyFrom?.id || uid; // confessing target: person being replied to, or the sender
  if (P.kind === 'propose') {
    const res = rel.romanceEvent('propose', { partner: target, note: 'user proposal', chatId });
    if (res.ok) return { reply: 'ایول داداش 😂❤️ قبوله، بزن بریم خواستگاری!', replyTo: ctx.msg.message_id };
    return { reply: 'مهره‌هام قاطیه داداش 😅 الان یه رابطه‌ای درگیرشم', replyTo: ctx.msg.message_id };
  }
  const r = rel.get(chatId, uid);
  const res = rel.romanceEvent('user_confess', { partner: uid, note: 'user confess', chatId });
  if (res.ok) {
    if (r.int >= 55 || r.trust >= 55) return { reply: 'ای... چه بگم والا 😅❤️ منم یه چیزایی بودم، بریم ببینیم چی می‌شه 👀', replyTo: ctx.msg.message_id };
    return { reply: 'اوه اوه داداش 😂 یه کم با هم آشناتر بشیم بعد قضاوت کنم', replyTo: ctx.msg.message_id };
  }
  const res2 = rel.romanceEvent('user_positive', { partner: uid, note: 'user positive', chatId });
  if (res2.ok) return { reply: 'پس شدیم یه زوج رسمی گروه 😂❤️ رئیس شاهد!', replyTo: ctx.msg.message_id };
  return { reply: 'قلبو ماهیانه‌م الان رفقاست داداش 😅', replyTo: ctx.msg.message_id };
}

function handleRomanceBreak(ctx) {
  const res = rel.romanceEvent('user_breakup', { note: 'user breakup', chatId: ctx.chatId, partner: ctx.uid });
  if (res.ok) return { reply: 'چشم... خاطره‌ها پیش خودمون می‌مونه 🥲 موفق باشی', replyTo: ctx.msg.message_id };
  return { reply: 'والا ماجراجویی عاطفی در کار نبود داداش 😂', replyTo: ctx.msg.message_id };
}

// ---------------------------------------------------------------- dispatcher
export async function runIntent(det, ctx) {
  try {
    switch (det.intent) {
      case 'search_person': return handleSearch(ctx, det.params);
      case 'ask_person_info': return handleAskInfo(ctx, det.params);
      case 'teach_identity': return handleTeachIdentity(ctx, det.params);
      case 'teach_term': return handleTeachTerm(ctx, det.params);
      case 'correct_info': return handleCorrect(ctx, det.params);
      case 'ask_memory': return handleAskMemory(ctx, det.params);
      case 'ask_events': return handleEvents(ctx);
      case 'request_report': return handleReport(ctx, det.params);
      case 'request_dis': return await handleDis(ctx, det.params);
      case 'manage_forget': return handleForget(ctx);
      case 'ask_about_me': return handleAboutMe(ctx);
      case 'romance_hit': return handleRomance(ctx, det.params);
      case 'romance_break': return handleRomanceBreak(ctx);
      default: return null;
    }
  } catch (e) {
    console.error('intent handler error:', det?.intent, e.message);
    return null;
  }
}
