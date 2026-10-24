// lib/normalizer.js — Persian text processing (spec §8)
// Goals: normalize ONLY for matching/understanding; never destroy meaning.
// - Arabic↔Persian char unification (ي ی, ك ک, ة ...)
// - diacritics + tatweel removal
// - ZWNJ / spacing variants (می‌خوام / میخوام / می خوام)
// - repeated-letter collapse (خخخخ → خخ) for matching
// - common typo/slang map (small, growable via learning system)

const AR2FA = {
  'ي': 'ی', 'ى': 'ی', 'ك': 'ک', 'ة': 'ه', 'أ': 'ا', 'إ': 'ا', 'ٱ': 'ا', 'ؤ': 'و',
  '٠': '۰', '١': '۱', '٢': '۲', '٣': '۳', '٤': '۴', '٥': '۵', '٦': '۶', '٧': '۷', '٨': '۸', '٩': '۹',
  '0': '۰', '1': '۱', '2': '۲', '3': '۳', '4': '۴', '5': '۵', '6': '۶', '7': '۷', '8': '۸', '9': '۹',
};

// common informal variants → canonical (for intent matching only) — no \b: JS \b is ASCII-only and breaks on Persian
const TYPOS = [
  [/می\s*خو?ام/g, 'می‌خوام'], [/میخام/g, 'می‌خوام'], [/میخوام/g, 'می‌خوام'],
  [/چطوری/g, 'چطور'], [/چه\s*طور/g, 'چطور'], [/چطورین/g, 'چطور'],
  [/دادا?ش/g, 'داداش'],
  [/چی\s*کار\s*می\s*کنی/g, 'چیکار می‌کنی'],
  [/سلا?م/g, 'سلام'],
  [/منشنش?/g, 'تگش'], [/منت?شن/g, 'تگ'],
  [/چیه/g, 'چیست'], [/چی\s*هست/g, 'چیست'],
];

const DIACRITICS = /[\u064B-\u0652\u0670\u0640\u0653-\u065F]/g;
const ZWNJ = /\u200C/g;

export function normalizeChars(s) {
  if (!s) return '';
  let t = String(s);
  t = t.replace(/[\u0621-\u064A\u0651\u0640]/g, ch => (AR2FA[ch] !== undefined ? AR2FA[ch] : ch));
  t = t.replace(DIACRITICS, '');
  return t;
}

// full normalization for storage/matching: unify chars, tidy spacing
export function normalize(s) {
  if (!s) return '';
  let t = normalizeChars(String(s).trim());
  t = t.replace(/[«»"'«»]/g, '');
  t = t.replace(/(\S)\s*\u200C\s*(\S)/g, '$1\u200C$2');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// aggressive key for fuzzy matching: no ZWNJ/spaces/punct, collapsed repeats
const SMALL_CAPS = { 'ᴀ':'a','ʙ':'b','ᴄ':'c','ᴅ':'d','ᴇ':'e','ꜰ':'f','ɢ':'g','ʜ':'h','ɪ':'i','ᴊ':'j','ᴋ':'k','ʟ':'l','ᴍ':'m','ɴ':'n','ᴏ':'o','ᴘ':'p','Q':'q','ʀ':'r','ꜱ':'s','ᴛ':'t','ᴜ':'u','ᴠ':'v','ᴡ':'w','x':'x','ʏ':'y','ᴢ':'z' };
const FA2EN = { 'ش':'sh','چ':'ch','خ':'kh','ژ':'zh','غ':'gh','پ':'p','ث':'s','ج':'j','ح':'h','د':'d','ذ':'z','ر':'r','ز':'z','س':'s','ص':'s','ض':'z','ط':'t','ظ':'z','ع':'a','ف':'f','ق':'gh','ک':'k','گ':'g','ل':'l','م':'m','ن':'n','و':'v','ه':'h','ی':'i','آ':'a','ا':'a','ب':'b','ت':'t' };
export function matchKey(s) {
  if (!s) return '';
  let t = normalizeChars(String(s));
  t = t.replace(/[ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘQʀꜱᴛᴜᴠᴡxʏᴢ]/g, ch => SMALL_CAPS[ch] || ch);
  t = t.replace(ZWNJ, '').replace(DIACRITICS, '');
  t = t.replace(/[^\p{L}\p{N}]+/gu, '');
  t = t.replace(/(.)\1+/gu, '$1'); // خخخخ → خ
  return t.toLowerCase();
}

// cross-script consonant skeleton: «علی»≈«ali», «ɪᴠᴏʀʏ»≈«ivory» (§3.2)
const VOWELS = /[aeiou]/g;
export function nameKey(s) {
  let t = matchKey(s);
  t = t.replace(/[شچخژغپثجحدذرزسصضطظعفقکلمنوهیآابتيك]/g, ch => FA2EN[ch] || ch);
  const latin = (t.match(/[a-z]/g) || []).length;
  if (latin > 0 && latin >= t.length * 0.6) t = t.replace(VOWELS, '');
  return t;
}

export function applyTypos(s) {
  let t = normalize(s);
  for (const [re, rep] of TYPOS) t = t.replace(re, rep);
  return t;
}

// emoji / text stats (style learning)
export function textStats(s) {
  const t = String(s || '');
  const emoji = (t.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
  const letters = (t.match(/[\p{L}]/gu) || []).length;
  return { emoji: emoji > 0, letters, len: t.length };
}

// hard-stop words: never used in diss even at highest severity (spec §11.4)
const HARD_STOP = /کیر|کسده|کس ننه|جنده|کص|حرومزاده|مادرت|خواهرت|عمه‌ات|ابلت/i;
export function hardStop(s) { return HARD_STOP.test(normalizeChars(String(s || ''))); }
