// lib/db.js — structured data model + people search engine (spec §1, §2, §3, §7, §15)
// Everything lives in one JSON object persisted by store.js.
// Confidence model (§1.3): verified | self | reported | inferred  (+ status: active | stale | conflict)

import { normalize, matchKey, nameKey, textStats } from './normalizer.js';
import * as store from './store.js';
const CAPS = { history: 30, lastTexts: 5, memoriesPerChat: 300, events: 500, learnedPerChat: 200, ownReplies: 10 };

export function db() { return store.getData(); }
const dirty = () => store.markDirty();
const now = () => Date.now();

// ---------------------------------------------------------------- users (§1.1/§1.2)
export function ensureUser(uid, name, username, t = now()) {
  if (!uid) return null;
  const d = db();
  uid = String(uid);
  if (!d.users[uid]) {
    d.users[uid] = {
      id: Number(uid), names: [], usernames: [], nicknames: [],
      selfInfo: [], othersInfo: [], interests: [], prefs: {},
      firstSeen: t, lastSeen: t, groups: {},
    };
  }
  const u = d.users[uid];
  if (name) {
    const nm = normalize(name);
    if (nm && u.names[0] !== nm) {
      // new display name → keep history, current first (§1.2)
      if (u.names.includes(nm)) u.names = [nm, ...u.names.filter(n => n !== nm)];
      else u.names.unshift(nm);
      if (u.names.length > 6) u.names.length = 6;
    }
  }
  if (username) {
    const un = String(username).replace(/^@/, '');
    if (un && u.usernames[0] !== un) {
      if (u.usernames.includes(un)) u.usernames = [un, ...u.usernames.filter(x => x !== un)];
      else u.usernames.unshift(un);
      if (u.usernames.length > 4) u.usernames.length = 4;
    }
  }
  u.lastSeen = t;
  dirty();
  return u;
}

export function getUser(uid) { return db().users[String(uid)] || null; }

// ---------------------------------------------------------------- per-message learning (§1.3, §2.1)
export function observeMessage(chatId, uid, name, username, text, t = now()) {
  const u = ensureUser(uid, name, username, t);
  if (!u) return;
  const g = u.groups[chatId] || (u.groups[chatId] = { count: 0, emoji: false, avgLen: 20, lastTexts: [] });
  g.count++;
  const st = textStats(text);
  g.emoji = g.emoji || st.emoji;
  g.lastTexts.push(String(text).slice(0, 100));
  if (g.lastTexts.length > CAPS.lastTexts) g.lastTexts.shift();
  g.avgLen = Math.round(g.lastTexts.reduce((a, x) => a + x.length, 0) / g.lastTexts.length);

  const h = chatHistory(chatId);
  h.push({ name: name || u.names[0] || '؟', uid: Number(uid), text: String(text).slice(0, 200), t });
  if (h.length > CAPS.history) h.shift();
  dirty();
  return u;
}

export function chatHistory(chatId) {
  const d = db();
  if (!d.chatHistory[chatId]) d.chatHistory[chatId] = [];
  return d.chatHistory[chatId];
}

export function pushOwnReply(chatId, text) {
  const d = db();
  if (!d.ownReplies[chatId]) d.ownReplies[chatId] = [];
  d.ownReplies[chatId].push(String(text).slice(0, 100));
  if (d.ownReplies[chatId].length > CAPS.ownReplies) d.ownReplies[chatId].shift();
  dirty();
}
export function ownReplies(chatId) { return db().ownReplies[chatId] || []; }

// ---------------------------------------------------------------- memories (§2.2, §2.4)
// kind: fact | interaction | quote ; conf: verified | self | reported | inferred
export function addMemory(chatId, { uid, kind, text, conf = 'inferred', source = null, t = now() }) {
  const d = db();
  if (!d.memories[chatId]) d.memories[chatId] = [];
  const textN = normalize(text).slice(0, 200);
  if (!textN) return null;
  const m = d.memories[chatId];
  // dedupe: same uid + same normalized text
  if (m.some(x => x.text === textN && x.uid === Number(uid))) return null;
  m.push({ t, uid: Number(uid), kind, text: textN, conf, status: 'active', source });
  if (m.length > CAPS.memoriesPerChat) m.splice(0, m.length - CAPS.memoriesPerChat);
  dirty();
  return m[m.length - 1];
}

export function searchMemories(chatId, { uid = null, q = '', limit = 6 } = {}) {
  const m = db().memories[chatId] || [];
  const qk = matchKey(q);
  let out = m.filter(x => x.status !== 'stale');
  if (uid) out = out.filter(x => x.uid === Number(uid));
  if (qk) {
    const words = [qk];
    out = out
      .map(x => ({ x, s: (matchKey(x.text).includes(qk) ? 2 : 0) }))
      .filter(r => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .map(r => r.x);
    if (!out.length && words.length) out = [];
  }
  return out.slice(-limit).reverse(); // newest first
}

export function markMemoryStale(chatId, textKey) {
  const m = db().memories[chatId] || [];
  for (const x of m) if (matchKey(x.text) === matchKey(textKey)) { x.status = 'stale'; dirty(); return true; }
  return false;
}

// ---------------------------------------------------------------- learned terms (§7)
export function addLearned(chatId, { term, meaning, by, conf = 'reported', t = now() }) {
  const d = db();
  if (!d.learned[chatId]) d.learned[chatId] = [];
  const key = matchKey(term);
  if (!key || !normalize(meaning)) return { ok: false, why: 'empty' };
  const arr = d.learned[chatId];
  const prev = arr.find(x => x.key === key && x.status !== 'conflict');
  if (prev) {
    if (matchKey(prev.meaning) === matchKey(meaning)) return { ok: true, updated: false, entry: prev };
    // conflict (§7.3): keep both flagged, don't auto-decide
    prev.status = 'conflict';
    arr.push({ term: normalize(term), key, meaning: normalize(meaning).slice(0, 160), by: Number(by), t, conf, status: 'conflict', updatedAt: t });
    dirty();
    return { ok: true, updated: true, conflict: true, entry: arr[arr.length - 1] };
  }
  arr.push({ term: normalize(term), key, meaning: normalize(meaning).slice(0, 160), by: Number(by), t, conf, status: 'active', updatedAt: t });
  if (arr.length > CAPS.learnedPerChat) arr.splice(0, arr.length - CAPS.learnedPerChat);
  dirty();
  return { ok: true, updated: true, entry: arr[arr.length - 1] };
}

export function findLearnedIn(chatId, text) {
  const arr = (db().learned[chatId] || []).filter(x => x.status === 'active');
  if (!arr.length) return [];
  const tN = normalize(text);
  const tK = matchKey(text);
  const hits = [];
  for (const x of arr) {
    if (tN.includes(x.term) || tK.includes(x.key)) hits.push(x);
  }
  return hits;
}

export function listLearned(chatId, limit = 12) {
  return (db().learned[chatId] || []).filter(x => x.status !== 'stale').slice(-limit).reverse();
}

// ---------------------------------------------------------------- events (§6.3)
let evSeq = 1;
export function addEvent({ chat, type, uids = [], summary, conf = 'inferred', ref = null, t = now() }) {
  const d = db();
  const ev = { id: `${t}-${evSeq++}`, chat: Number(chat), t, type, uids: uids.map(Number), summary: normalize(summary).slice(0, 160), conf, status: 'active', ref };
  d.events.push(ev);
  if (d.events.length > CAPS.events) d.events.splice(0, d.events.length - CAPS.events);
  dirty();
  return ev;
}

export function recentEvents(chatId, limit = 6, types = null) {
  const t0 = now() - 3 * 24 * 60 * 60 * 1000; // last 3 days window for freshness
  return (db().events || [])
    .filter(e => e.chat === Number(chatId) && e.status === 'active' && (!types || types.includes(e.type)) && e.t >= t0)
    .slice(-limit).reverse();
}

export function eventsAbout(chatId, uid, limit = 4) {
  return (db().events || [])
    .filter(e => e.chat === Number(chatId) && e.status === 'active' && e.uids.includes(Number(uid)))
    .slice(-limit).reverse();
}

// ---------------------------------------------------------------- privacy (§1.3, §14)
export function setPrivacy(uid, patch) {
  const d = db();
  uid = String(uid);
  if (!d.privacy[uid]) d.privacy[uid] = {};
  Object.assign(d.privacy[uid], patch, { at: now() });
  dirty();
  return d.privacy[uid];
}
export function privacyOf(uid) { return db().privacy[String(uid)] || null; }

// purge a user's data (§1.5): users entry, memories ref, relations; keep tombstone
export function forgetUser(chatId, uid) {
  const d = db();
  uid = String(uid);
  delete d.users[uid];
  if (d.memories[chatId]) d.memories[chatId] = d.memories[chatId].filter(m => m.uid !== Number(uid));
  if (d.relations[chatId]) delete d.relations[chatId][uid];
  if (d.chatHistory[chatId]) d.chatHistory[chatId] = d.chatHistory[chatId].filter(h => h.uid !== Number(uid));
  setPrivacy(uid, { forgetRequested: true });
  dirty();
  return true;
}

// ---------------------------------------------------------------- people search (§3)
// Multi-strategy scored search: names (current/old), usernames, nicknames,
// self-info/interests/quotes, memories, event summaries. Returns ranked candidates.
export function searchPeople(chatId, query, { excludeUid = null, limit = 5 } = {}) {
  const qN = normalize(query);
  const qK = matchKey(query);
  const qNK = nameKey(query);
  const qWords = qN.split(/\s+/).filter(w => w.length > 1).map(matchKey).filter(Boolean);
  if (!qK && !qWords.length) return [];
  const out = new Map(); // uid -> {uid, name, score, reasons}

  const push = (uid, score, reason) => {
    if (excludeUid && Number(uid) === Number(excludeUid)) return;
    const u = db().users[String(uid)];
    if (!u || !u.names.length) return;
    const cur = out.get(String(uid)) || { uid: Number(uid), name: u.names[0], username: u.usernames[0] || null, score: 0, reasons: [] };
    cur.score = Math.max(cur.score, score);
    if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
    out.set(String(uid), cur);
  };

  for (const [uid, u] of Object.entries(db().users)) {
    // 1) name matching — two layers:
    //    (a) normalized Persian text (keeps multi-word names distinguishable)
    //    (b) cross-script skeleton (علی≈ali, Sᴏᴋᴏᴏᴛ≈SOKOOT) — substring only when both ≥3
    for (const nm of u.names) {
      const nN = normalize(nm).replace(/\s+/g, ' ');
      const qN2 = qN.replace(/\s+/g, ' ');
      const nk = nameKey(nm);
      if (!nk && !nN) continue;
      const nPlain = nN.replace(/\s+/g, '');
      const qPlain = qN2.replace(/\s+/g, '');
      const minLen = Math.min(nk.length, qNK.length);
      const minPlain = Math.min(nPlain.length, qPlain.length);
      if (nN === qN2 || nk === qNK) push(uid, 100, `اسمش «${nm}»ئه`);
      else if (minPlain >= 3 && (nPlain.includes(qPlain) || qPlain.includes(nPlain))) push(uid, 80, `اسمش «${nm}»ه`);
      else if (minLen >= 3 && (nk.includes(qNK) || qNK.includes(nk))) push(uid, 70, `اسمش «${nm}»ه`);
    }
    // 2) usernames (current + old) — same guard
    for (const un of u.usernames) {
      const uk = matchKey(un);
      const minLen = Math.min(uk.length, qK.length);
      if (uk && (uk === qK || (minLen >= 3 && (uk.includes(qK) || qK.includes(uk))))) push(uid, 75, `آیدیش @${un}ئه`);
    }
    // 3) nicknames taught to Kavan (§3.2) — same guard
    for (const nn of u.nicknames || []) {
      const nk = matchKey(nn.text);
      const minLen = Math.min(nk.length, qK.length);
      if (nk && (nk === qK || (minLen >= 3 && (nk.includes(qK) || qK.includes(nk))))) push(uid, 85, `بهش می‌گن «${nn.text}»`);
    }
    // 4) description keywords: interests, self-info, quotes, last texts
    const haystack = [
      ...(u.interests || []), ...(u.selfInfo || []).map(s => s.text),
      ...(u.othersInfo || []).map(s => s.text),
      ...((u.groups[chatId]?.lastTexts) || []),
    ].map(normalize);
    if (qWords.length && haystack.some(h => wordRatio(matchKey(h), qWords) >= 0.75)) {
      push(uid, 45, 'پیام‌هاش/اطلاعاتش به توصیف می‌خوره');
    }
  }

  // 5) memories about someone (e.g. «همون که با محمد بحثش شد»)
  for (const m of db().memories[chatId] || []) {
    if (m.uid && qWords.length) {
      const ratio = wordRatio(matchKey(m.text), qWords);
      if (ratio === 1) push(m.uid, 50, `یادمه: ${m.text.slice(0, 50)}`);
      else if (ratio >= 0.6) push(m.uid, 42, `شاید منظورت این بود — یادمه: ${m.text.slice(0, 40)}`);
    }
  }
  // 6) event summaries (§6)
  for (const ev of db().events || []) {
    if (ev.chat !== Number(chatId) || !ev.uids?.length) continue;
    for (const uid of ev.uids) {
      const ratio = wordRatio(matchKey(ev.summary), qWords);
      if (ratio === 1) push(uid, 40, `تو این اتفاق بود: ${ev.summary.slice(0, 50)}`);
      else if (ratio >= 0.6) push(uid, 41, `شاید — تو این اتفاق بود: ${ev.summary.slice(0, 40)}`);
    }
  }

  return [...out.values()].filter(c => c.score >= 40).sort((a, b) => b.score - a.score).slice(0, limit);
}

// word-overlap ratio tolerant to person-ending of verbs (می‌زنه ≈ می‌زنم) (§3.2)
function wordRatio(textKey, qWords) {
  if (!qWords.length) return 0;
  let hit = 0;
  for (const w of qWords) {
    if (textKey.includes(w)) { hit++; continue; }
    // try stem: drop 2 trailing chars (نم/نه/تون endings)
    if (w.length > 4 && (textKey.includes(w.slice(0, w.length - 2)) || textKey.includes(w.slice(0, w.length - 1)))) hit += 0.75;
  }
  return hit / qWords.length;
}

// nickname management (taught aliases) (§1.1, §7.1)
export function addNickname(uid, nick, by) {
  const u = ensureUser(uid);
  if (!u) return null;
  const nickN = normalize(nick);
  if (!nickN) return null;
  if (!(u.nicknames || []).some(n => matchKey(n.text) === matchKey(nickN))) {
    u.nicknames = u.nicknames || [];
    u.nicknames.push({ text: nickN, by: Number(by), at: now(), conf: 'reported' });
    dirty();
  }
  return u;
}

export function addSelfInfo(uid, text, t = now()) {
  const u = ensureUser(uid);
  if (!u) return null;
  const tN = normalize(text).slice(0, 160);
  if (tN && !(u.selfInfo || []).some(s => matchKey(s.text) === matchKey(tN))) {
    u.selfInfo = u.selfInfo || [];
    u.selfInfo.push({ text: tN, at: t, conf: 'self' });
    if (u.selfInfo.length > 12) u.selfInfo.shift();
    dirty();
  }
  return u;
}

export function addInterest(uid, text) {
  const u = ensureUser(uid);
  if (!u) return null;
  const tN = normalize(text).slice(0, 60);
  if (tN && !(u.interests || []).some(s => matchKey(s) === matchKey(tN))) {
    u.interests = u.interests || [];
    u.interests.push(tN);
    if (u.interests.length > 10) u.interests.shift();
    dirty();
  }
  return u;
}

// ---------------------------------------------------------------- roster (persona input)
export function rosterOf(chatId, limit = 10) {
  const d = db();
  const rows = Object.values(d.users)
    .filter(u => u.groups[chatId]?.count)
    .sort((a, b) => b.groups[chatId].count - a.groups[chatId].count)
    .slice(0, limit);
  return rows.map(u => ({
    uid: u.id, name: u.names[0], username: u.usernames[0] || null,
    count: u.groups[chatId].count, avgLen: u.groups[chatId].avgLen, emoji: u.groups[chatId].emoji,
    nicknames: (u.nicknames || []).map(n => n.text).slice(0, 3),
    selfInfo: (u.selfInfo || []).slice(-2).map(s => s.text),
    interests: (u.interests || []).slice(0, 4),
  }));
}

export function stats() {
  const d = db();
  return {
    users: Object.keys(d.users || {}).length,
    memories: Object.values(d.memories || {}).reduce((a, m) => a + m.length, 0),
    events: (d.events || []).length,
    learned: Object.values(d.learned || {}).reduce((a, l) => a + l.length, 0),
    romances: d.romance?.state || 'none',
  };
}
