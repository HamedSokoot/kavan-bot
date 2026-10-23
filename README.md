# 🤖 راهنمای دیپلوی بات کاوان روی Render (آنلاین ۲۴/۷)

## مرحله ۱ — ساخت ریپو گیت‌هاب
1. برو به github.com → New repository → اسم بذار `kavan-bot` → Public → Create
2. دو فایل `app.py` و `requirements.txt` رو آپلود کن (Add file → Upload files → Commit)

## مرحله ۲ — دیپلوی روی Render
1. برو به **render.com** → لاگین (اگه قبلاً بات قدیمی رو اونجا داشتی، همون اکانت)
2. **New + → Web Service** → «Build and deploy from a Git repository» → Connect GitHub → ریپوی `kavan-bot` رو انتخاب کن
3. تنظیمات:
   - **Runtime:** Python 3
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `gunicorn app:app --bind 0.0.0.0:$PORT --timeout 120`
   - **Instance Type:** Free
4. بخش **Environment Variables** این دو تا رو اضافه کن:
   - `BOT_TOKEN` = توکن رباتت (همونی که به دستیار دادی)
   - `OWNER_ID` = `6252224878`
5. **Create Web Service** بزن و صبر کن دیپلوی بشه (۲-۳ دقیقه)

## مرحله ۳ — فعال‌سازی وبهوک
آدرسی که Render بهت می‌ده (مثل `https://kavan-bot.onrender.com`) رو به دستیارت بده تا وبهوک رو ست کنه.
یا خودت این دستور رو تو مرورگر اجرا کن (URL رو جایگزین کن):

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR-APP.onrender.com/webhook
```

جواب `"ok":true` گرفتی یعنی کاوان **همیشه آنلاینه** ✅

## نکات مهم
- پلن رایگان Render بعد از ۱۵ دقیقه بی‌کاری می‌خوابه؛ ولی هر پیام تلگرام سرور رو بیدار می‌کنه (فقط اولین جواب ممکنه ۳۰-۵۰ ثانیه طول بکشه)
- برای اینکه اصلاً نخوابه، تو **UptimeRobot.com** یه مانیتور رایگان بساز که هر ۵ دقیقه به `https://YOUR-APP.onrender.com` ping بده
- خواب/بیداری سرور فایل آرشیو رو پاک نمی‌کنه؛ فقط redeploy یا restart کامل، آرشیو رو از نو شروع می‌کنه

## بعد از دیپلوی
- تو گروه بهش منشن بده یا ریپلی کن: `@Taj_Parsian_Bot سلام` → جواب می‌ده
- تو چت خصوصی بنویس «پنل» → پنل مدیریت میاد با دکمه‌های زنده
- دستورهای ارباب تو گروه: «تگ @فلانی» و «پنل»
