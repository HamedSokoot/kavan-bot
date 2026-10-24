// lib/store.js — durable storage layer (spec §2.5, §15.2)
// Backend: local JSON file (cache + fast) + optional GitHub private repo sync
// (real durability on Render's ephemeral disk — env GITHUB_TOKEN/GITHUB_REPO).
// Atomic writes (tmp+rename), dirty-flag debounce, NEVER logs secrets, never throws.

import fs from 'fs';
import path from 'path';

const LOCAL_FILE = path.join(process.cwd(), 'kavan_db.json');
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = process.env.GITHUB_REPO || '';      // e.g. HamedSokoot/kavan-memory
const GH_PATH = process.env.GITHUB_MEMORY_PATH || 'kavan_db.json';
const SYNC_EVERY_MS = 4 * 60 * 1000;                // push at most every 4 min
const PULL_MAX_AGE = 24 * 60 * 60 * 1000;           // ignore remote if older than local by >24h anyway

let state = { data: null, dirty: false, lastSync: 0, syncing: false, lastError: '', enabled: false, lastPull: null };

function ghHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${GH_TOKEN}`,
    'User-Agent': 'kavan-bot',
    Accept: 'application/vnd.github+json',
    ...extra,
  };
}

async function ghGet() {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${GH_PATH}`, {
    headers: ghHeaders(), signal: AbortSignal.timeout(20000),
  });
  if (r.status === 404) return null;               // first boot
  if (!r.ok) throw new Error(`github get ${r.status}`);
  const j = await r.json();
  return { sha: j.sha, content: JSON.parse(Buffer.from(j.content, 'base64').toString('utf-8')), updated_at: j.updated_at };
}

async function ghPut(obj, sha) {
  const body = { message: `memory sync ${new Date().toISOString()}`, content: Buffer.from(JSON.stringify(obj)).toString('base64') };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${GH_PATH}`, {
    method: 'PUT', headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`github put ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return (await r.json()).content?.sha;
}

export function load(fallback) {
  // 1) local file first (fast boot); remote merge happens in pullRemote()
  let local = null;
  try { local = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf-8')); } catch (_) {}
  if (GH_TOKEN && GH_REPO) state.enabled = true;
  if (local) { state.data = local; return { source: 'local' }; }
  state.data = fallback || {
    version: 1, savedAt: new Date().toISOString(),
    users: {}, memories: {}, events: [], relations: {}, romance: null,
    learned: {}, chatHistory: {}, ownReplies: {}, privacy: {}, settings: {},
  };
  return { source: 'empty' };
}

// async remote pull merged over local (called once at boot)
export async function pullRemote(data) {
  if (!state.enabled) return { source: 'disabled' };
  try {
    const g = await ghGet();
    if (g && g.content) {
      const localSaved = data?.savedAt ? Date.parse(data.savedAt) : 0;
      const remoteSaved = g.content?.savedAt ? Date.parse(g.content.savedAt) : 0;
      if (remoteSaved >= localSaved - PULL_MAX_AGE) {
        state.data = g.content;
        state.lastPull = g.updated_at;
        persistLocal();
        return { source: 'remote', updated_at: g.updated_at, sha: g.sha };
      }
      // keep local (newer) but remember remote sha for the next PUT
      state.remoteSha = g.sha;
      return { source: 'local-newer', remote_updated_at: g.updated_at };
    }
    return { source: 'remote-empty' };
  } catch (e) {
    state.lastError = e.message;
    return { source: 'error', error: e.message };
  }
}

export function getData() { return state.data; }
export function markDirty() { state.dirty = true; }

export function persistLocal() {
  if (!state.data) return;
  try {
    const tmp = LOCAL_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state.data));
    fs.renameSync(tmp, LOCAL_FILE);
  } catch (e) { console.error('store: local write failed:', e.message); }
}

let lastSha = null;
export async function sync(reason = 'timer') {
  if (!state.data || state.syncing) return { ok: false, why: 'busy/empty' };
  if (!state.enabled) return { ok: false, why: 'no github env' };
  if (!state.dirty && Date.now() - state.lastSync < PULL_MAX_AGE) return { ok: false, why: 'clean' };
  state.syncing = true;
  try {
    persistLocal();
    let sha = state.remoteSha || lastSha;
    if (!sha) { const g = await ghGet().catch(() => null); sha = g?.sha || null; }
    lastSha = await ghPut(state.data, sha);
    state.remoteSha = lastSha;
    state.dirty = false; state.lastSync = Date.now(); state.lastError = '';
    return { ok: true, reason };
  } catch (e) {
    state.lastError = e.message;
    return { ok: false, why: e.message };
  } finally { state.syncing = false; }
}

export function startAutoSync() {
  // local flush every 60s (cheap, always-on) — GitHub push at most every 4min
  setInterval(() => { if (state.dirty) persistLocal(); }, 60 * 1000);
  setInterval(() => { if (state.dirty) sync('auto'); }, SYNC_EVERY_MS);
  const flush = () => { try { persistLocal(); } catch (_) {} };
  process.on('SIGTERM', flush); process.on('SIGINT', flush);
}

export function status() {
  return {
    backend: state.enabled ? 'local+github' : 'local-only',
    lastSync: state.lastSync ? new Date(state.lastSync).toISOString() : null,
    lastPull: state.lastPull,
    dirty: state.dirty,
    lastError: state.lastError || null,
    localFile: fs.existsSync(LOCAL_FILE) ? 'present' : 'absent',
  };
}
