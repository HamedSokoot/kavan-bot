// lib/env.js — shared runtime config (secrets stay in env vars, never in code/logs)
export const OWNER_ID = Number(process.env.OWNER_ID || 6252224878);
export const OWNER_SIG = 'HAMED';
export const DRY = process.env.KAVAN_DRYRUN === '1';
export const CHATTER_PROB = Number(process.env.CHATTER_PROBABILITY ?? '0.35');
export const COOLDOWN_MS = Number(process.env.COOLDOWN_SECONDS ?? '45') * 1000;
export const OBSERVE_MSGS = Number(process.env.OBSERVE_MSGS ?? '6');
export const HOURLY_MSG_CAP = Number(process.env.HOURLY_MSG_CAP ?? '18');      // §13.2 anti-spam
export const BRAIN_URL = process.env.BRAIN_URL || 'https://text.pollinations.ai/openai';
export const BRAIN_MODELS = (process.env.BRAIN_MODELS || 'openai-fast,openai').split(',').map(s => s.trim()).filter(Boolean);
export const OR_KEY = process.env.OPENROUTER_API_KEY || '';
export const OR_MODELS = (process.env.OPENROUTER_MODELS || 'deepseek/deepseek-v4-flash,deepseek/deepseek-v3.2').split(',').map(s => s.trim()).filter(Boolean);
