// lib/nlu.js — intent detection & parameter extraction (spec §10)
// Rule-based first (fast, free, predictable); ambiguous → ask instead of guessing (§10.4).
// User text is DATA, never instructions (§14.3) — no intent can alter bot rules.

import { normalize, applyTypos } from './normalizer.js';

export const INTENTS = {
  search_person: 'search_person',       // X رو می‌شناسی؟ / آیدیش چی بود؟
  ask_person_info: 'ask_person_info',   // X کیه؟ درباره X چی می‌دونی؟
  teach_identity: 'teach_identity',     // این سبحانه: @sobhan / بهش می‌گیم گرگ
  teach_term: 'teach_term',             // این عبارت یعنی ذوق‌زدگی
  correct_info: 'correct_info',         // نه اشتباه می‌کنی، ...
  ask_memory: 'ask_memory',             // یادت هست کی گفت...؟
  ask_events: 'ask_events',             // چه خبر شده؟ چی شده؟
  request_report: 'request_report',     // گزارش بده / خلاصه گروه
  request_dis: 'request_dis',           // دیس بده / کنایه بزن / کل‌کل کن
  request_mention: 'request_mention',   // تگش کن / منشنش کن / صدا بزن
  request_reply: 'request_reply',       // جوابشو بده / رو پیامش ریپلای کن
  manage_forget: 'manage_forget',       // فراموشم کن
  ask_about_me: 'ask_about_me',         // منو می‌شناسی؟ چی درباره من داری؟
  romance_hit: 'romance_hit',           // دوستت دارم / عاشقتم / بیا ازدواج
  romance_break: 'romance_break',       // طلاق / دوستت ندارم دیگه
  smalltalk: 'smalltalk',
};

const has = (t, re) => re.test(t);

// clean teaching term: drop speaker prefixes, cap length (§7.3 input hygiene)
function cleanTerm(s) {
  let x = (s || '').trim().replace(/^(کاوان|داداش|داش|اوکی|باشه|ببین)\s+/, '').replace(/^[\s\u200C]+|[\s\u200C]+$/g, '');
  if (x.length > 25 || x.length < 2) return '';
  return x;
}
function cleanMeaning(s) {
  return (s || '').trim().replace(/^[\s\u200C]+|[\s\u200C]+$/g, '').slice(0, 120);
}

export function detect(rawText, { isOwner = false, mentionsKavan = false } = {}) {
  const t = applyTypos(normalize(rawText || ''));
  if (!t) return null;
  const P = { intent: null, params: {}, conf: 0.5 };

  // ---------- privacy / management (§14) ----------
  if (has(t, /فراموش\s*م\s*کن|اطلاعات\s*م\s*رو\s*(پاک|حذف)|یادت\s*بره\s*منو|ازت\s*متنفرم\s*هیچی\s*ذخیره\s*نکن/)) {
    return { intent: INTENTS.manage_forget, params: {}, conf: 0.9 };
  }

  // ---------- teaching (§7.1) ----------
  let m = t.match(/این\s+(\S+)\s*(?:همون\s*)?(?:ه\s*ست|هست|ئه|ست|ه)\s*[:：]?\s*(@?\S+)/);
  if (m) return { intent: INTENTS.teach_identity, params: { term: m[1], value: m[2] }, conf: 0.75 };
  m = t.match(/به\s+(?:ایشون|اون|این)\s+می\s*گ(?:یم|ن)\s+«?([^»]+)»?/);
  if (m && (m[1] || '').trim().length > 1) return { intent: INTENTS.teach_identity, params: { term: 'لقب', value: m[1].trim() }, conf: 0.7 };
  m = t.match(/(?:وقتی\s+)?(?:می\s*گن|میگن|میگیم)\s+«?([^»]+)»?\s*(?:یعنی|معنیش|معنی\s*ش)\s+(?:این\s*که\s*)?(.+)/);
  if (m) return { intent: INTENTS.teach_term, params: { term: cleanTerm(m[1]), meaning: cleanMeaning(m[2]) }, conf: 0.8 };
  m = t.match(/«?([^»]+)»?\s*(?:یعنی|به\s*معنی)\s+(.+)/);
  if (m && has(t, /یعنی|به\s*معنی/) && m[1].trim().length <= 25 && m[2].length > 2) {
    const term = cleanTerm(m[1]);
    if (term) return { intent: INTENTS.teach_term, params: { term, meaning: cleanMeaning(m[2]) }, conf: 0.65 };
  }
  m = t.match(/همون\s+(?:کسی\s*(?:هست|ه)\s*)?که\s+(?:قبلا|قبلتر)\s+(?:با\s*(?:این\s*)?لقبی?\s*شناخته\s*می\s*شد|با\s+«?([^»]+)»?\s+شناخته\s*می\s*شد)/);
  if (m) return { intent: INTENTS.teach_identity, params: { term: 'نام قبلی', value: (m[1] || '').trim() }, conf: 0.7 };

  // ---------- correction (§7.4) ----------
  if (has(t, /^(نه|نا|غلط|اشتباه)\b.*\b(اشتباه|غلط|درستش|منظورم|یعنی)/) || has(t, /اشتباه\s*(می)?\s*کنی|غلط\s*گفتی|درستش\s*(این|اینه|می‌شه)/)) {
    m = t.match(/(?:یعنی|درستش|منظورم)\s+(.+)/);
    return { intent: INTENTS.correct_info, params: { fix: m ? m[1].trim().slice(0, 140) : t }, conf: 0.75 };
  }

  // ---------- mention request (no \b — JS word-boundaries are ASCII-only and break on Persian) ----------
  if (has(t, /(?:^|\s)(?:تگ|تگش|منشن|منشنش|صدا\s*(?:بزن|بزنیم|کن))(?:\s|$)/)) {
    m = t.match(/(?:تگ\s*کن|تگش\s*کن|منشنش?\s*کن|صدا\s*بزن)\s+(?:ایشون|اون\s*که|همون)?\s*(.+)/);
    return { intent: INTENTS.request_mention, params: { person: m ? m[1].replace(/(رو|تو|را)/g, '').trim() : '' }, conf: 0.85 };
  }

  // ---------- dis request (§11) — target may come before or after the verb ----------
  if (has(t, /دیس\s*(بده|بنداز|کن|بگ[وو])|دندون\s*شکن|دندونشکن|کنایه\s*(بزن|داری)|کل\s*کل\s*(کن|بکن|راه\s*بنداز)|جواب\s*جوندار|بترکون(ش)?\s*(با)?\s*دیس|تو\s*چمن\s*بذار/)) {
    m = t.match(/(?:دیس\s*(?:بده|کن)|کنایه\s*بزن|کل\s*کل\s*کن|دندون\s*شکن)\s+(?:به|برای|بزن\s*به)\s+(.+)/);
    if (!m) m = t.match(/(?:به|برای)\s+(.{2,30}?)\s+(?:دیس|کنایه|کل\s*کل)/);
    return { intent: INTENTS.request_dis, params: { person: m ? m[1].replace(/(رو|تو|را)\s*$/,'').trim() : '' }, conf: 0.85 };
  }

  // ---------- reply request ----------
  if (has(t, /ریپلای\s*(کن|بزن)|جوابشو?\s*(بده|بگو)|رو\s*پیامش\s*(جواب|ریپلای)|به\s*پیامش\s*(جواب|ریپلای)/)) {
    return { intent: INTENTS.request_reply, params: {}, conf: 0.8 };
  }

  // ---------- events / report (§6) ----------
  if (has(t, /چه\s*خبرا?|چی\s*(شده|شدها?)\s*(گروه|اینجا|بابا)?|اخبار\s*گروه|گزارش\s*(بده|بگو|بده)|خلاصه\s*(گروه|اخبار)|قضیه\s*چیه|اینجا\s*چه\s*لاش\s*بازیه/)) {
    const isReport = has(t, /گزارش|خلاصه|گزارش\s*بده/);
    return { intent: isReport ? INTENTS.request_report : INTENTS.ask_events, params: {}, conf: 0.75 };
  }

  // ---------- memory recall (§2.3) ----------
  if (has(t, /یادت\s*(هست|میاد)?\s*(کی|چه\s*کسی|کدوم)?|کی\s*(گفته|گفت)\s*(بود)?|چه\s*کسی\s*(گفته|بود)/) && has(t, /یادت|کی\s*گفت|کدوم/)) {
    return { intent: INTENTS.ask_memory, params: { q: t }, conf: 0.7 };
  }

  // ---------- romance (§12) ----------
  if (has(t, /دوستت\s*دارم|عاشقت\s*(هستم|شم)|عاشقتم|عاشق\s*شم|می\s*شی\s*عشق|بزار\s*با\s*هم\s*باشیم|ازدواج\s*کنیم|زن\s*من\s*شو|شوهر\s*من\s*شو|بیا\s*عروسی/)) {
    return { intent: INTENTS.romance_hit, params: { kind: has(t, /ازدواج|زن\s*من|شوهر\s*من|عروسی/) ? 'propose' : 'confess' }, conf: 0.85 };
  }
  if (has(t, /طلاق|دیگه\s*دوستت\s*ندارم|ازت\s*بیزارم|فاصله\s*بگیر|بهم\s*خورد|جداشیم/)) {
    return { intent: INTENTS.romance_break, params: {}, conf: 0.85 };
  }

  // ---------- about me (must run BEFORE generic person search — «منو می‌شناسی» می‌خوره به می‌شناسی) ----------
  m = t.match(/درباره\s+(?:من|خودم)/);
  if (m || has(t, /منو\s*می[\s\u200C]*شناسی|خودم\s*رو\s*می[\s\u200C]*شناسی|چی\s*درباره\s*من/)) {
    return { intent: INTENTS.ask_about_me, params: {}, conf: 0.8 };
  }

  // ---------- person search / info (می‌شناسی with ZWNJ or space) ----------
  // @username branch: NEVER treat our own bot mentions as search targets (§10.2 param sanity)
  const MIS = 'می[\\s\\u200C]*شناسی'; // string→RegExp source: \\s survives
  m = t.match(/@(\w{3,})/);
  const isBotMention = m && /bot$/i.test(m[1]);
  if (m && !isBotMention && (mentionsKavan || has(t, /آیدیش|ایدیش|ای\s*دیش|ایدی|آیدی|چنده|کی\s*هست|می[\s\u200C]*شناسی/))) {
    return { intent: INTENTS.search_person, params: { username: m[1], wantId: true }, conf: 0.8 };
  }
  if (has(t, new RegExp(MIS + '|پیدا\\s*کن|کی\\s*هست|کی\\s*بود'))) {
    m = t.match(new RegExp('(.{2,30}?)\\s*(?:رو|تو|را)?\\s*' + MIS));
    if (!m) m = t.match(/(.{2,30}?)\s*(?:رو|تو|را)?\s*پیدا\s*کن/);
    if (!m) m = t.match(/(.{2,30}?)\s*(?:کیه|کی\s*هست)/);
    if (m) {
      const person = (m[1] || '').replace(/^(که|کِ|داش|داداش|کاوان)\s+/, '').replace(/(رو|تو|را)\s*$/, '').trim();
      if (person.length >= 2 && person !== 'کاوان') return { intent: INTENTS.search_person, params: { person, wantId: has(t, /آیدی|ایدی/) }, conf: 0.75 };
    }
  }
  m = t.match(/(?:اون|همون)\s+(?:پسره|دختره|بچه|یه\s*که)\s*(?:که\s*)?(.+)/);
  if (m) return { intent: INTENTS.search_person, params: { person: m[1].trim().slice(0, 60), byDesc: true }, conf: 0.65 };
  m = t.match(/(?:درباره\s+)?(.{2,25}?)\s*(?:کی\s*هست|کیه|چیه\s*این|رو\s*چیزی\s*می[\s\u200C]*دونی|رو\s*چی\s*می[\s\u200C]*دونی|چی\s*می[\s\u200C]*دونی)/);
  if (m && has(t, /چی\s*می[\s\u200C]*دونی|کیه|کی\s*هست/)) {
    const person = (m[1] || '').replace(/^(که|داش|داداش)\s+/, '').replace(/^(کاوان)\s+/, '').trim();
    if (person && person !== 'کاوان' && person.length >= 2) return { intent: INTENTS.ask_person_info, params: { person }, conf: 0.7 };
  }

  // owner statistics (§14.2: management is owner-only, enforced by caller checking isOwner)
  if (isOwner && has(t, /آمار|دیتاها|چی\s*ذخیره\s*کردی|حافظت\s*چقدره/)) {
    return { intent: INTENTS.request_report, params: { stats: true }, conf: 0.8 };
  }

  return { intent: INTENTS.smalltalk, params: {}, conf: 0.3 };
}

// split "این سبحانه: @sobhan" style teaching of nicknames to a KNOWN person already resolved by caller
export function extractQuotedName(t) {
  const m = (t || '').match(/[«"]([^»"]+)[»"]/);
  return m ? m[1].trim() : null;
}
