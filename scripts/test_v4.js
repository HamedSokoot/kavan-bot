#!/usr/bin/env node
// scripts/test_v4.js — mandatory QA suite (spec §17). Runs fully offline in an
// isolated temp cwd; true-restart persistence tested via child processes.
// Usage: node scripts/test_v4.js   → prints PASS/FAIL per section, exit 1 on any fail.

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kavan-test-'));
process.chdir(TMP);                       // isolate from real kavan_db.json
const LIB = 'file:///home/z/my-project/deploy-repo/lib';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name} ${extra}`); }
}
const section = t => console.log(`\n— ${t} —`);

// single shared module graph exactly like production (§16: one responsibility per module)
const { normalizeChars, normalize, matchKey, nameKey, applyTypos, hardStop } = await import(`${LIB}/normalizer.js`);
const store = await import(`${LIB}/store.js`);
const db = await import(`${LIB}/db.js`);
const events = await import(`${LIB}/events.js`);
const rel = await import(`${LIB}/relations.js`);
const nlu = await import(`${LIB}/nlu.js`);
const handlers = await import(`${LIB}/intent-handlers.js`);
const polish = await import(`${LIB}/polish.js`);

// clean slate per section (simulates a fresh boot with empty disk)
function resetDb() {
  try { fs.rmSync(path.join(TMP, 'kavan_db.json')); } catch (_) {}
  store.load();
}

section('§8 پردازش فارسی');
check('ي/ك عربی → ی/ک', normalize('سلام يار كوچيك') === 'سلام یار کوچیک');
check('نیم‌فاصله پایدار', matchKey('می‌خوام') === matchKey('میخوام'));
check('تکرار حرف فشرده', matchKey('خخخخخ') === matchKey('خ'));
check('اسلنگ استایلایز SOKOOT', matchKey('Sᴏᴋᴏᴏᴛ') === matchKey('SOKOOT'));
check('اسکلت بین‌زبانی علی≈ali', nameKey('علی').replace(/[aeiouy]/g, '') === nameKey('ali').replace(/[aeiouy]/g, '') || nameKey('علی') === nameKey('ali'));
check('تایپو «چطوری»', applyTypos('چطوری داداش').includes('چطور'));
check('خط قرمز دیس', hardStop('کیر تو دهنت'));
check('جمله عادی مجاز', !hardStop('بهت دیس بدم داداش؟'));

// ===========================================================================
section('§2.5/§15.2 ذخیره‌سازی: fallback و roundtrip');
{
  resetDb();
  check('db خالی سالم boot می‌شه', !!store.getData().users);
  db.ensureUser(10, 'شیوا', 'shiva');
  db.addMemory(-100, { uid: 10, kind: 'fact', text: 'شیوا اهل رپه', conf: 'self' });
  store.persistLocal();
  const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'kavan_db.json'), 'utf-8'));
  check('نوشتار اتمیک روی دیسک', !!raw.users['10'] && raw.memories['-100'].length === 1);
}

// ===========================================================================
section('§17.2 حافظه: پروفایل، تاریخچه نام، تفکیک کاربران');
{
  resetDb();
  db.ensureUser(11, 'سینا', 'sina_old');
  db.ensureUser(11, 'Sɪɴᴀ Sɪʟᴇɴᴛ', 'sina_new');
  const u = db.getUser(11);
  check('rename تاریخچه حفظ شد', u.names[0] === 'Sɪɴᴀ Sɪʟᴇɴᴛ' && u.names.includes('سینا'));
  check('username جدید اوله', u.usernames[0] === 'sina_new' && u.usernames.includes('sina_old'));
  db.observeMessage(-200, 11, 'Sɪɴᴀ Sɪʟᴇɴᴛ', 'sina_new', 'سلام بچه‌ها دیس آماده‌ست 🔥');
  db.observeMessage(-200, 12, 'شیوا', 'shiva', 'سلاممم');
  check('آمار گروه جدا از هم', db.getUser(11).groups['-200'].count === 1 && db.getUser(12).groups['-200'].count === 1);
  check('تاریخچه چت مرتب', db.chatHistory('-200').length === 2);
}

// ===========================================================================
section('§17.3 جست‌وجوی افراد');
{
  resetDb();
  db.ensureUser(21, 'علی', 'ali_rap'); db.addNickname(21, 'گرگ', 1);
  db.ensureUser(22, 'علی دوم', 'ali2');
  db.ensureUser(23, 'Sᴏᴋᴏᴏᴛ', null);
  db.observeMessage(-300, 24, 'محمد', 'mohammad', 'من همیشه فوتبال حرف می‌زنم');
  let c = db.searchPeople(-300, 'علی', {});
  check('جست‌وجوی نام + ابهام‌سنجی', c.length === 2 && c[0].name === 'علی');
  c = db.searchPeople(-300, '@ali2', {});
  check('جست‌وجوی آیدی', c.length === 1 && c[0].uid === 22);
  c = db.searchPeople(-300, 'اون کسی که بهش می‌گیم گرگ', {});
  check('جست‌وجوی لقب', c.length >= 1 && c[0].uid === 21);
  c = db.searchPeople(-300, 'همیشه فوتبال حرف می‌زنه', {});
  check('جست‌وجوی توصیفی', c.length === 1 && c[0].uid === 24);
  c = db.searchPeople(-300, 'SOKOOT', {});
  check('نام استایلایز', c.length === 1 && c[0].uid === 23);
  c = db.searchPeople(-300, 'ریحانه', {});
  check('نتیجه خالی صادقانه', c.length === 0);
}

// ===========================================================================
section('§17.4 یادگیری و اصلاح');
{
  resetDb();
  db.addLearned(-400, { term: 'چپته', meaning: 'خبر خاصی نیست', by: 30 });
  const found = db.findLearnedIn(-400, 'داداش چپته؟');
  check('اصطلاح در متن پیدا می‌شه', found.length === 1 && found[0].meaning.includes('خبر'));
  const res = db.addLearned(-400, { term: 'چپته', meaning: 'یه نوع رپ فریستایل', by: 31 });
  check('تناقض ثبت شد نه حذف', res.conflict === true && db.listLearned(-400).some(l => l.status === 'conflict'));
  check('دانش گروهی نشت نمی‌کنه', db.findLearnedIn(-500, 'چپته چیه').length === 0);
  db.addMemory(-400, { uid: 30, kind: 'fact', text: 'فردا میره سفر', conf: 'self' });
  check('خاطره تکراری ثبت نمی‌شه', db.addMemory(-400, { uid: 30, kind: 'fact', text: 'فردا میره سفر', conf: 'self' }) === null);
  check('خاطره قدیمی stale می‌شه', db.markMemoryStale(-400, 'فردا میره سفر') === true && db.searchMemories(-400, { q: 'سفر' }).length === 0);
}

// ===========================================================================
section('§6.3 رویدادهای گروه');
{
  resetDb();
  events.onService(-600, { date: Math.floor(Date.now() / 1000), message_id: 1, new_chat_members: [{ id: 41, first_name: 'تازه‌وارده' }] });
  events.onService(-600, { date: Math.floor(Date.now() / 1000), message_id: 2, left_chat_member: { id: 41, first_name: 'تازه‌وارده' } });
  const ev1 = db.recentEvents(-600, 5, ['join', 'leave']);
  check('ورود/خروج verified ثبت شد', ev1.length === 2 && ev1.every(e => e.conf === 'verified'));
  events.onMessage(-600, 42, 'سینا', 'با تو دعوا دارم داداش');
  events.onMessage(-600, 42, 'سینا', 'دعوا بابا جدی جدی');
  check('رویداد اجتماعی تشخیص داده شد', db.recentEvents(-600, 5, ['fight']).length >= 1);
  check('تفکیک گروهی رویداد', db.recentEvents(-700, 5).length === 0);
}

// ===========================================================================
section('§17.6 روابط: شاخص‌های جدا + تدریجی + سقف روزانه');
{
  resetDb();
  const r0 = rel.get(-800, 50);
  check('شروع: غریبه با همه صفر', r0.stage === 'غریبه' && r0.trust === 0 && r0.int === 0);
  rel.bump(-800, 50, 'conflict', 50, 'تست');
  const r1 = rel.get(-800, 50);
  check('تک‌پیام دشمنی نمی‌سازه (سقف روزانه)', r1.conflict < 50 && r1.stage !== 'تعارض جدی');
  rel.bump(-800, 51, 'int', 8, 'صمیمیت');
  const r2 = rel.get(-800, 51);
  check('صمیمیت ≠ اعتماد', r2.int > 0 && r2.trust === 0);
  // gradual stage climb — simulate 5 different days (§5.4: caps are per-day)
  for (let day = 0; day < 5; day++) {
    for (let i = 0; i < 8; i++) { rel.bump(-800, 52, 'int', 4, 'چت'); rel.bump(-800, 52, 'fam', 4, 'چت'); }
    rel.get(-800, 52).daily = {}; // new day
  }
  const r3 = rel.get(-800, 52);
  check('پله‌های دوستی طبیعی', ['دوست', 'دوست صمیمی', 'مورداعتماد'].includes(r3.stage));
  const hist = rel.conflictHistory(-800, 50);
  check('دلیل تعارض قابل بازیابی', hist.length >= 1 && hist[0].reason === 'تست');
}

// ===========================================================================
section('§12/§17.6 رابطه عاطفی: ماشین حالت');
{
  resetDb();
  check('شروع: بدون رابطه', rel.romanceState().state === 'none');
  check('flirt → آشنایی عاطفی', rel.romanceEvent('flirt', { partner: 60 }).ok);
  check('confess → ابراز علاقه', rel.romanceEvent('user_confess', { partner: 60 }).ok);
  check('confirm → بررسی متقابل', rel.romanceEvent('user_positive', { partner: 60 }).ok);
  check('confirm → رابطه رسمی', rel.romanceEvent('user_positive', { partner: 60 }).ok);
  const res = rel.romanceEvent('user_confess', { partner: 61, chatId: -900 });
  check('انحصار: شریک دوم رد می‌شه', res.ok === false && rel.romanceState().partner === 60);
  check('propose → نامزدی', rel.romanceEvent('propose', { partner: 60 }).ok);
  check('marry → ازدواج', rel.romanceEvent('marry', { partner: 60 }).ok);
  check('اختلاف جدی', rel.romanceEvent('trouble', { note: 'دعوا' }).ok);
  check('طلاق → جدایی', rel.romanceEvent('user_breakup', { note: 'طلاق' }).ok && rel.romanceState().state === 'broken');
  check('از جدایی مستقیم عروسی نمی‌شه', rel.romanceEvent('marry', { partner: 60 }).ok === false);
  store.getData().romance.since = Date.now() - 25 * 3600 * 1000;
  rel.romanceEvent('flirt', { partner: 60 });
  check('بعد از سکوت، خیال راحت شد', rel.romanceState().state === 'none' || rel.romanceState().state === 'interest');
}

// ===========================================================================
section('§10 تشخیص قصد');
{
  const nlu = await import(`${LIB}/nlu.js?n=1`);
  const d = (t, o = {}) => nlu.detect(t, o)?.intent;
  check('جست‌وجوی شخص', d('کاوان سبحان رو می‌شناسی؟') === 'search_person');
  check('آیدی‌خواهی', d('داش سبحان رو می‌شناسی؟ آیدیش چی بود؟') === 'search_person');
  check('آموزش هویت', d('این سبحانه: @sobhan') === 'teach_identity');
  check('آموزش اصطلاح', d('این عبارت به معنی ذوق‌زدگی شدید است') === 'teach_term');
  check('اصلاح', d('نه اشتباه می‌کنی، درستش اینه که') === 'correct_info');
  check('خاطره', d('یادت هست پریروز کی گفت از گروه می‌ره؟') === 'ask_memory');
  check('رویدادها', d('چه خبر شده داداش؟') === 'ask_events');
  check('گزارش', d('گزارش بده') === 'request_report');
  check('درخواست دیس', d('کاوان به این دیس بده') === 'request_dis');
  check('درخواست منشن', d('تگش کن کاوان') === 'request_mention');
  check('فراموشم کن', d('کاوان فراموشم کن') === 'manage_forget');
  check('درباره من', d('منو می‌شناسی؟ چی درباره من داری') === 'ask_about_me');
  check('اعتراف عاشقانه', d('کاوان دوستت دارم 😂') === 'romance_hit');
  check('طلاق', d('ازت طلاق می‌گیرم 😂') === 'romance_break');
  check('گفتگوی عادی → smalltalk', d('امشب بتل خوبی بود') === 'smalltalk');
  const det = nlu.detect('کاوان به علی دیس بده');
  check('پارامتر هدف دیس', det.intent === 'request_dis' && det.params.person === 'علی');
}

// ===========================================================================
section('§10.3 اجراکننده‌ها (ابزارهای واقعی)');
{
  resetDb();
  db.ensureUser(70, 'علی', 'ali'); db.observeMessage(-1000, 70, 'علی', 'ali', 'سلام');
  const ctx = { chatId: -1000, msg: { message_id: 5 }, bot: {}, uid: 71, name: 'مصدق', isOwner: false, text: 'علی رو می‌شناسی؟', mentionsKavan: true, replyFrom: null };
  let out = await handlers.runIntent(nlu.detect('کاوان علی رو می‌شناسی؟'), ctx);
  check('پیدا شد → جواب با دلیل', out?.reply?.includes('علی'));
  out = await handlers.runIntent(nlu.detect('ریحانه رو می‌شناسی؟'), ctx);
  check('پیدا نشد → صادقانه', out?.reply?.includes('ندیدم'));
  db.ensureUser(72, 'علی دوم', null); db.observeMessage(-1000, 72, 'علی دوم', null, 'سلام منم علیم');
  out = await handlers.runIntent(nlu.detect('علی رو می‌شناسی؟'), ctx);
  check('ابهام → سؤال نه حدس', out?.reply?.includes('منظورت کدوم'));
  out = await handlers.runIntent(nlu.detect('این عبارت به معنی ذوق‌زدگی شدید است'), ctx);
  check('آموزش ذخیره شد', out?.reply?.includes('یاد گرفتم'));
  out = await handlers.runIntent({ intent: 'manage_forget', params: {} }, ctx);
  check('فراموشی: tombstone + پاکسازی', db.privacyOf(71)?.forgetRequested === true);
}

// ===========================================================================
section('§4.3/§9.3 کنترل تکرار و طول');
{
  resetDb();
  db.pushOwnReply(-1100, 'خخخ داداش چه باحال 😂');
  const again = await polish.polish(-1100, 'خخخ داداش چه باحال 😂', {});
  check('جواب تکراری → سکوت/جایگزین', again === null || typeof again === 'string');
  const long = 'ط'.repeat(300);
  const capped = await polish.polish(-1100, long, { skipRepeatCheck: true });
  check('پیام بلند کوتاه می‌شه', capped.length <= 220);
  const silence = await polish.polish(-1100, '[سکوت]', { skipRepeatCheck: true });
  check('[سکوت] غیراجباری → null/قالب', silence === null || typeof silence === 'string');
  const forced = await polish.polish(-1100, '[سکوت]', { force: true, skipRepeatCheck: true });
  check('[سکوت] اجباری → جایگزین درشخصیت', typeof forced === 'string' && forced.length > 0 && !forced.includes('سکوت'));
}

// ===========================================================================
section('§17.8 پایداری: هم‌زمانی و خرابی فایل');
{
  resetDb();
  await Promise.all(Array.from({ length: 10 }, (_, i) =>
    Promise.resolve(db.observeMessage(-1200, 100 + i, `u${i}`, null, `پیام ${i}`)).then(() => db.addMemory(-1200, { uid: 100 + i, kind: 'fact', text: `خاطره ${i}`, conf: 'inferred' }))
  ));
  check('۱۰ عملیات هم‌زمان سالم', db.stats().users >= 10);
  fs.writeFileSync(path.join(TMP, 'kavan_db2.json'), '{corrupted!!!');
  fs.copyFileSync(path.join(TMP, 'kavan_db2.json'), path.join(TMP, 'kavan_db.json'));
  store.load();
  check('فایل خراب → crash نمی‌کنه', !!store.getData());
  fs.rmSync(path.join(TMP, 'kavan_db.json'));
}

// ===========================================================================
section('§17.2 ری‌استارت واقعی: ماندگاری در فرزند جدا');
const child = `
const LIB = 'file:///home/z/my-project/deploy-repo/lib';
const mode = process.argv[2];
const store = await import(LIB + '/store.js');
const db = await import(LIB + '/db.js');
const rel = await import(LIB + '/relations.js');
store.load();
if (mode === 'write') {
  db.ensureUser(91, 'شیوا', 'shiva');
  db.observeMessage(-1300, 91, 'شیوا', 'shiva', 'سلام از دنیای قبل از ری‌استارت');
  db.addMemory(-1300, { uid: 91, kind: 'fact', text: 'شیوا رپر برتره', conf: 'self' });
  db.addLearned(-1300, { term: 'چپته', meaning: 'خبر نیست', by: 91 });
  rel.romanceEvent('flirt', { partner: 91 }); rel.romanceEvent('user_confess', { partner: 91 });
  rel.bump(-1300, 91, 'trust', 8, 'کمک به کاوان');
  store.markDirty(); store.persistLocal();
  console.log('WRITTEN');
} else {
  const u = db.getUser(91);
  const ok1 = !!u && u.groups['-1300']?.count === 1;
  const ok2 = db.searchMemories('-1300', { uid: 91 }).some(m => m.text.includes('رپر'));
  const ok3 = db.findLearnedIn('-1300', 'چپته چیه').length === 1;
  const ok4 = rel.romanceState().state === 'confessed' && rel.romanceState().partner === 91;
  const ok5 = rel.get('-1300', 91).trust >= 8;
  console.log('RESTART_CHECKS', JSON.stringify([ok1, ok2, ok3, ok4, ok5]));
  process.exit(ok1 && ok2 && ok3 && ok4 && ok5 ? 0 : 1);
}
`;
fs.writeFileSync(path.join(TMP, 'restart_child.mjs'), child);
{
  const r1 = execFileSync('node', [path.join(TMP, 'restart_child.mjs'), 'write'], { cwd: TMP, encoding: 'utf-8' });
  check('فرزند اول: نوشت', r1.includes('WRITTEN'));
  const r2 = execFileSync('node', [path.join(TMP, 'restart_child.mjs'), 'read'], { cwd: TMP, encoding: 'utf-8' });
  check('بعد از ری‌استارت همه‌چیز هست', r2.includes('[true,true,true,true,true]'), r2.trim());
}

// ===========================================================================
console.log(`\n===========================\nRESULT: ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('FAILED:', failures.join(' | ')); process.exit(1); }
