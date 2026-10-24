// lib/events.js — group event detection & memory (spec §6)
// Real events (join/leave) come from Telegram service messages (conf: verified).
// Social events (fight/reconcile/notable) are keyword-detected conservatively (conf: inferred).
// Joke-vs-serious rule (§6.2): never record a serious conflict from a single message
// unless the sender's conflict relation is low AND no shared-joke context — the
// relation module smooths this (single joke ≠ permanent enemy).

import * as db from './db.js';

const FIGHT = /(دعوا)|(بحث\s*شد)|(کت\s*کت)|(زدم\s*تو\s*سرت)|(دیشمت)|(دیس\s*داد)|(قطع\s*رابطه)|(حالم\s*ازت\s*به\s*هم)|(دیگه\s*حرف\s*نزن)/;
const RECONCILE = /(آشتی)|(آشتی‌)?کنون|(بد\s*نگیر)|(شوخی\s*کردم)|(تعارف\s*نداریم\s*ولی)|(حل\s*شد)|(آشتی\s*کردیم)/;
const AGREEMENT = /(قرار\s*شد)|(توافق)|(ساعت\s*\d)|(ساعت\s*\d+\s*شب)|(فردا\s*\S+\s*میای)|(همه\s*بیاید)/;
const NOTABLE = /(از\s*گروه\s*می‌رم)|(از\s*گروه\s*میرم)|(الان\s*می‌رم)|(تولدم)|(عروسم)|(قبول\s*شدم)|(افتادم)|(بیمار\s*شدم)|(مردم\s*از\s*خنده)/;

const window_ = new Map(); // chatId -> {fightAt, lastType, sameTypeCount} debounce
function debounceOk(chatId, type, ms = 30 * 60 * 1000) {
  const w = window_.get(chatId) || {};
  const key = `last_${type}`;
  if (w[key] && Date.now() - w[key] < ms) return false;
  w[key] = Date.now();
  window_.set(chatId, w);
  return true;
}

// service message handlers (called from server.js on Telegram service updates)
export function onService(chatId, msg) {
  const t = (msg.date || Math.floor(Date.now() / 1000)) * 1000;
  if (msg.new_chat_members) {
    for (const u of msg.new_chat_members) {
      if (u.is_bot) continue;
      db.ensureUser(u.id, u.first_name + (u.last_name ? ' ' + u.last_name : ''), u.username, t);
      db.addEvent({ chat: chatId, type: 'join', uids: [u.id], summary: `${u.first_name || 'عضو تازه'} وارد گروه شد`, conf: 'verified', ref: msg.message_id, t });
    }
    return true;
  }
  if (msg.left_chat_member) {
    const u = msg.left_chat_member;
    if (!u.is_bot) db.addEvent({ chat: chatId, type: 'leave', uids: [u.id], summary: `${u.first_name || 'یکی'} گروه رو ترک کرد`, conf: 'verified', ref: msg.message_id, t });
    return true;
  }
  return false;
}

// content-based detection on every text message (cheap, rule-based)
export function onMessage(chatId, uid, name, text) {
  const t = Date.now();
  const txt = text || '';
  let type = null, summary = null;
  if (FIGHT.test(txt)) { type = 'fight'; summary = `${name} یه بحث/دیس تند بالا گرفت`; }
  else if (RECONCILE.test(txt)) { type = 'reconcile'; summary = `${name} به‌سمت آشتی/شوخی رفت`; }
  else if (AGREEMENT.test(txt)) { type = 'agreement'; summary = `${name}: «${txt.slice(0, 60)}» (برنامه/قرار)`; }
  else if (NOTABLE.test(txt)) { type = 'notable'; summary = `${name}: «${txt.slice(0, 60)}»`; }
  if (!type) return null;
  // fight needs debouncing (spam-protection, §6.2 no-certainty rule)
  if (type === 'fight' && !debounceOk(chatId, 'fight')) return null;
  return db.addEvent({ chat: chatId, type, uids: [uid], summary, conf: type === 'fight' || type === 'reconcile' ? 'inferred' : 'inferred', t });
}

export function describe(chatId, limit = 5) {
  const evs = db.recentEvents(chatId, limit);
  if (!evs.length) return [];
  const fa = { join: 'ورود', leave: 'خروج', fight: 'بحث', reconcile: 'آشتی', agreement: 'قرار', notable: 'اتفاق' };
  return evs.map(e => {
    const d = new Date(e.t);
    const ago = Math.floor((Date.now() - e.t) / 3600000);
    const when = ago < 1 ? 'همین الانا' : ago < 24 ? `${ago} ساعته پیش` : `${Math.floor(ago / 24)} روزه پیش`;
    return `[${fa[e.type] || e.type}] ${e.summary} (${when})`;
  });
}
