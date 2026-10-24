// lib/relations.js — dynamic relationship system (spec §5) + romance FSM (§12)
// Five independent indices (§5.1): fam(آشنایی) int(صمیمیت) trust(اعتماد) like(علاقه) conflict(تعارض)
// Gradual updates with daily caps (§5.4) — one message never flips a relationship.
// Romance is a guarded state machine, ONE partner max (§12.2), persisted (§12.6).

import * as db from './db.js';
import * as store from './store.js';

export const STAGES = { stranger: 'غریبه', acquaintance: 'آشنا', friend: 'دوست', close: 'دوست صمیمی', trusted: 'مورداعتماد', rival: 'رقیب', foe: 'تعارض جدی' };

const DAILY_CAP = { fam: 12, int: 10, trust: 10, like: 8, conflict: 14 };

const rel = () => { const d = db.db(); if (!d.relations) d.relations = {}; return d.relations; };
const rom = () => { const d = db.db(); return d.romance; };

export function ensure(chatId, uid) {
  const R = rel();
  if (!R[chatId]) R[chatId] = {};
  const c = R[chatId];
  const key = String(uid);
  if (!c[key]) {
    c[key] = { fam: 0, int: 0, trust: 0, like: 0, conflict: 0, stage: STAGES.stranger, since: Date.now(), updated: Date.now(), daily: {}, history: [] };
    store.markDirty();
  }
  return c[key];
}

function decayIfStale(r) {
  const days = (Date.now() - r.updated) / 86400000;
  if (days > 3) { // slow cooling for absentees (not a punishment)
    r.fam = Math.max(0, r.fam - Math.min(6, days * 0.5));
    r.int = Math.max(0, r.int - Math.min(4, days * 0.3));
    r.updated = Date.now();
    store.markDirty();
  }
}

// gradual, capped bump; kind: fam|int|trust|like|conflict (negative amount reduces)
export function bump(chatId, uid, kind, amount, reason, { ownerBypass = false } = {}) {
  if (ownerBypass) {
    const r = ensure(chatId, uid);
    apply(r, kind, amount, reason, true);
    return r;
  }
  const r = ensure(chatId, uid);
  const today = new Date().toISOString().slice(0, 10);
  if (!r.daily) r.daily = {};
  if (r.daily.k !== today) r.daily = { k: today };
  const used = r.daily[kind] || 0;
  const cap = DAILY_CAP[kind] ?? 10;
  if (Math.abs(amount) > 0) {
    const sign = Math.sign(amount);
    const room = sign > 0 ? Math.max(0, cap - used) : Math.max(0, 20 - used); // reductions capped at -20/day
    const eff = sign * Math.min(Math.abs(amount), room);
    if (eff === 0) return r;
    r.daily[kind] = used + Math.abs(eff);
    apply(r, kind, eff, reason);
  }
  return r;
}

function apply(r, kind, eff, reason, uncapped = false) {
  const idx = { fam: 'fam', int: 'int', trust: 'trust', like: 'like', conflict: 'conflict' }[kind];
  if (!idx) return;
  r[idx] = Math.min(100, Math.max(0, r[idx] + eff));
  r.updated = Date.now();
  r.history = r.history || [];
  r.history.push({ t: Date.now(), kind, d: eff, reason: String(reason || '').slice(0, 60) });
  if (r.history.length > 25) r.history.shift();
  r.stage = stageOf(r);
  store.markDirty();
}

export function stageOf(r) {
  if (r.conflict >= 60) return STAGES.foe;
  if (r.conflict >= 35) return STAGES.rival;
  if (r.trust >= 70 && r.int >= 70) return STAGES.trusted;
  if (r.int >= 55 && r.fam >= 55) return STAGES.close;
  if (r.int >= 35 || r.fam >= 45) return STAGES.friend;
  if (r.fam >= 18) return STAGES.acquaintance;
  return STAGES.stranger;
}

export function get(chatId, uid) {
  const r = ensure(chatId, uid);
  decayIfStale(r);
  return r;
}

// short Persian summary used inside the LLM prompt (tone adaptation §4.2/§5)
export function summarize(chatId, uid, name) {
  const r = get(chatId, uid);
  const bits = [];
  bits.push(`رابطه کاوان با ${name}: ${r.stage}`);
  if (r.int > 60) bits.push('صمیمی — خودمونی‌تر و شوخ‌تر');
  else if (r.fam < 15) bits.push('غریبه — محتاط ولی مودبانه-خودمونی');
  if (r.conflict > 35) bits.push('بین‌شون کل‌کل/دیس هست — لحن رقابتی');
  if (r.trust > 65) bits.push('بهش اعتماد داره');
  return bits.join('؛ ');
}

// conflict memory recall (§5.5): why are we fighting with X?
export function conflictHistory(chatId, uid) {
  const r = get(chatId, uid);
  return (r.history || []).filter(h => h.kind === 'conflict' && h.d > 0).slice(-5).reverse();
}

// ============================================================================
// Romance FSM (§12) — global state; Kavan has one heart.
const RS = { none: 'بدون رابطه', interest: 'آشنایی عاطفی', crush: 'علاقه احتمالی', confessed: 'ابراز علاقه', checking: 'بررسی تمایل متقابل', official: 'رابطه رسمی', engaged: 'نامزدی', married: 'ازدواج', trouble: 'اختلاف جدی', broken: 'جدایی' };

// legal transitions: state -> { event: next }
const TRANS = {
  none:      { flirt: 'interest', user_confess: 'confessed', owner_set: 'interest' },
  interest:  { flirt: 'crush', user_confess: 'confessed', kavan_confess: 'confessed', user_negative: 'none', owner_set: 'crush' },
  crush:     { flirt: 'crush', user_confess: 'confessed', kavan_confess: 'confessed', user_negative: 'interest', owner_set: 'crush' },
  confessed: { user_positive: 'checking', user_negative: 'none', user_check: 'checking', user_breakup: 'broken', trouble: 'trouble' },
  checking:  { user_positive: 'official', user_negative: 'none', user_breakup: 'broken', trouble: 'trouble' },
  official:  { propose: 'engaged', user_negative: 'trouble', user_breakup: 'broken', trouble: 'trouble', reconcile: 'official' },
  engaged:   { marry: 'married', user_negative: 'trouble', user_breakup: 'broken', trouble: 'trouble', reconcile: 'engaged' },
  married:   { user_breakup: 'trouble', trouble: 'trouble', reconcile: 'married' },
  trouble:   { reconcile: 'official', user_breakup: 'broken', user_negative: 'broken' },
  broken:    { cooldown_over: 'none' },
};

export function romanceState() {
  const r = rom();
  if (!r || !r.state) return { state: 'none', stage: RS.none, partner: null, since: null, history: [] };
  return { ...r, stage: RS[r.state] || r.state };
}

function romTo(state, event, note, partner = null) {
  const d = db.db();
  d.romance = d.romance || { state: 'none', partner: null, since: null, history: [] };
  const r = d.romance;
  r.state = state;
  if (partner !== null) r.partner = partner;
  if (state === 'none') r.partner = null;
  if (!r.since || state === 'none') r.since = event === 'cooldown_over' ? r.since : Date.now();
  r.history = r.history || [];
  r.history.push({ t: Date.now(), event, state, note: String(note || '').slice(0, 80) });
  if (r.history.length > 30) r.history.shift();
  store.markDirty();
  return r;
}

// the only mutation gate — every romance change must pass through here (§12.3)
export function romanceEvent(event, { partner = null, note = '', chatId = null } = {}) {
  const cur0 = rom();
  const cur = cur0?.state || 'none';   // db.romance may be null on first boot
  // broken → none after 24h cooldown
  if (cur === 'broken' && Date.now() - (cur0?.since || 0) > 24 * 3600 * 1000) romTo('none', 'cooldown_over', 'بعد سکوت، خیالش راحت شد');
  const now_ = (rom()?.state || 'none');
  const legal = TRANS[now_] || {};
  const next = legal[event];
  if (!next || next === now_) return { ok: false, state: now_, why: `transition ${event} not allowed from ${now_}` };
  // exclusivity guard (§12.2)
  const curPartner = rom()?.partner;
  if (['confessed', 'checking', 'official', 'engaged', 'married'].includes(next) && curPartner && partner && curPartner !== partner) {
    return { ok: false, state: now_, why: 'already committed to someone else' };
  }
  romTo(next, event, note, partner ?? rom().partner);
  if (chatId && partner) {
    db.addMemory(chatId, { uid: partner, kind: 'interaction', text: `رابطه عاطفی کاوان: ${RS[next]}`, conf: 'verified' });
  }
  return { ok: true, state: next, stage: RS[next] };
}

// owner-only manual set (panel) — bypass FSM but log
export function romanceOwnerSet(action, partner, note = '') {
  if (action === 'reset') { romTo('none', 'owner_reset', note); return { ok: true, state: 'none' }; }
  const ev = { interest: 'owner_set', confess: 'kavan_confess', official: 'user_positive', engaged: 'propose', married: 'marry' }[action];
  if (!ev) return { ok: false, why: 'unknown action' };
  return romanceEvent(ev, { partner, note: `owner: ${note}` });
}

export function romancePromptLine() {
  const r = romanceState();
  if (r.state === 'none') return '';
  const p = r.partner ? db.getUser(r.partner) : null;
  const pn = p?.names?.[0] || 'کسی';
  return `رابطه عاطفی کاوان: ${r.stage} با ${pn}. رفتارت با اون مطابق این مرحله‌ست؛ عاشقانه‌ها فقط با خودش و در حد مرحله.`;
}
