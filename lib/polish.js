// lib/polish.js — outgoing message hard-filters (spec §4, §9, §17.7)
// Bot-talk absolute filter + [سکوت] handling + repetition control + length cap.
// Applies to EVERY outgoing text (LLM replies AND intent replies).

import * as db from './db.js';
import * as brain from './brain.js';
import { hardStop } from './normalizer.js';

export function mentionsBot(text) {
  const norm = (text || '').toLowerCase();
  if (/هوش\s*مصنوعی|artificial\s*intelligence/.test(norm)) return true;
  const tokens = norm.split(/[\s.,!?؟…:;()[\]"'»«\-_/\\]+/).filter(Boolean);
  return tokens.some(w => ['ربات', 'بات', 'باتی', 'باتم', 'رباتی', 'چتبات', 'ai', 'bot', 'robot', 'bots'].includes(w));
}

export const MENTION_FALLBACKS = ['جانم؟ 👀', 'گو داداش', 'بله؟ 😎', 'چه خبر؟', 'بعله؟'];
export const ACCUSE_FALLBACKS = ['حالا خودتم 😂', 'تو دیدنی داداش', 'چی رو گفتی 😂', 'برو بابا 😎'];
const lastFb = new Map();

export function pickFb(chatId, fallbacks) {
  const prev = lastFb.get(chatId);
  let t = fallbacks[Math.floor(Math.random() * fallbacks.length)];
  if (fallbacks.length > 1 && t === prev) t = fallbacks[(fallbacks.indexOf(t) + 1) % fallbacks.length];
  lastFb.set(chatId, t);
  return t;
}

// final outgoing filter. force=true → always returns something; else may return null (silence).
export async function polish(chatId, raw, { force = false, fallbacks = MENTION_FALLBACKS, rawText = '', skipRepeatCheck = false } = {}) {
  let reply = (raw || '').trim();
  if (!reply) return force ? pickFb(chatId, fallbacks) : brain.templateSay(rawText);
  if (mentionsBot(reply)) {
    let retry = null;
    try {
      retry = await brain.brainChat([{ role: 'user', content: 'جواب قبلیت اشاره به ربات داشت — ممنوع. مثل یه آدم معمولی کوتاه دوباره جواب بده.' }]);
    } catch (_) {}
    if (!retry || mentionsBot(retry)) return force ? pickFb(chatId, fallbacks) : null;
    reply = retry;
  }
  if (reply.includes('[سکوت]')) {
    if (!force) return brain.templateSay(rawText);
    return pickFb(chatId, fallbacks);
  }
  if (hardStop(reply)) reply = 'اینا رو نبگیم بهتره داداش 😅';
  if (reply.length > 220) reply = reply.slice(0, 210).trim() + '...';
  if (!skipRepeatCheck) {
    const prevOwn = db.ownReplies(chatId);
    if (prevOwn.includes(reply.slice(0, 80))) return force ? pickFb(chatId, fallbacks) : null; // §4.3
  }
  return reply;
}
