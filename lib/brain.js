// lib/brain.js — LLM chain: OpenRouter(deepseek) → Pollinations. Serialized,
// rate-limit aware, reasoning-leak-proof, circuit-breaker. Never throws upward.

import { BRAIN_URL, BRAIN_MODELS, OR_KEY, OR_MODELS } from './env.js';

let llmFails = 0, llmDisabledUntil = 0, llmLastOk = 0, llmLastErr = 'never called', llmLastCall = 0, orDailyBlockedUntil = 0;
let llmChain = Promise.resolve(); // serialize: one request at a time

// reasoning models sometimes leak chain-of-thought — clean or reject
function cleanReply(txt) {
  if (!txt) return null;
  let t = txt.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!t) return null;
  const langCheck = s => {
    const fa = (s.match(/[\u0600-\u06FF]/g) || []).length;
    const la = (s.match(/[A-Za-z]/g) || []).length;
    return fa > la;
  };
  if (/^(the user|we need|okay|let's|i need|first,|looking at)/i.test(t) || /\n\n(the user|we need|let's)/i.test(t)) {
    const parts = t.split(/\n{2,}/);
    const tail = (parts[parts.length - 1] || '').trim();
    if (tail && langCheck(tail)) t = tail; else return null;
  } else if (!langCheck(t)) return null;
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
      for (let pass = 0; pass < 2; pass++) {
        try {
          if (pass === 1) { if (!t.rlRetry) break; await new Promise(r => setTimeout(r, t.rlRetry)); }
          const body = t.url.includes('openrouter')
            ? { model: t.model, messages, max_tokens: 900, temperature: 0.95, reasoning: { effort: 'low', exclude: true } } // headroom for hidden reasoning
            : { model: t.model, messages, max_tokens: 150, temperature: 0.95, reasoning_effort: 'low', referrer: 'kavan-bot', private: true };
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
          if (!rl) break;
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

export { brainChat, cleanReply };

// offline template fallbacks (still in-character) — used when brain is down
const TPL = {
  greet: ['سلام داداش 🔥', 'سلاممم 👋 چه خبر؟', 'سلام جووون 👀', 'درود مشتی 😎'],
  how: ['خوبیم داداش، تو چطوری؟ 😎', 'قربونت، تو چیکاری؟ 👀', 'مرسی داداش تو خوبی؟'],
  laugh: ['خخخخخ 😂', 'وای خدای من 😂😂', 'نکش داداش خخ 😭', 'جون مادرت خفن کردی 😂'],
  q: ['والا خودمم موندم 😂', 'راستش نمیدونم داداش 😅', 'شاید بابا 👀', 'معلومه دیگه 😎'],
};
export function templateSay(text) {
  const t = text || '';
  const pick = a => a[Math.floor(Math.random() * a.length)];
  if (/^سلام|درود|هلو|hello|hi\b/i.test(t)) return pick(TPL.greet);
  if (/چطوری|خوبی|چه خبر|کجایی|چیکار می|حالت/i.test(t)) return pick(TPL.how);
  if (/😂|🤣|خخ|ههه|لول|لطیف|جک/.test(t)) return pick(TPL.laugh);
  if (/[?؟]/.test(t)) return pick(TPL.q);
  return null;
}

export function status() {
  return {
    brain: Date.now() < llmDisabledUntil ? 'fallback-templates' : (llmLastOk ? 'online' : 'warming-up'),
    brainModels: (OR_KEY && Date.now() >= orDailyBlockedUntil ? OR_MODELS : []).concat(BRAIN_MODELS),
    openrouterBlocked: orDailyBlockedUntil ? new Date(orDailyBlockedUntil).toISOString() : null,
    lastBrainError: llmLastErr || null,
    lastBrainOk: llmLastOk ? new Date(llmLastOk).toISOString() : null,
  };
}

export async function nettest() {
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
      out[name] = { ok: r.ok, status: r.status, ms: Date.now() - t0, sample: body.slice(0, 100) };
    } catch (e) { out[name] = { ok: false, error: e.message, ms: Date.now() - t0 }; }
  };
  if (OR_KEY && Date.now() >= orDailyBlockedUntil) await probe('openrouter', 'https://openrouter.ai/api/v1/chat/completions', OR_MODELS[0], { Authorization: `Bearer ${OR_KEY}` });
  await probe('pollinations', BRAIN_URL, BRAIN_MODELS[0], {});
  return out;
}
