"""Kavan bot server — 24/7 Telegram webhook bot for Render.com.

Env vars:
  BOT_TOKEN  — your Telegram bot token (required)
  OWNER_ID   — owner's Telegram user id (default: 6252224878)
  BOT_USERNAME — bot username without @ (default: Taj_Parsian_Bot)

Endpoints:
  GET  /         -> health check
  POST /webhook  -> Telegram updates
"""
import json
import os
import random
import threading
from datetime import datetime

import requests
from flask import Flask, request

TOKEN = os.environ["BOT_TOKEN"]
OWNER_ID = int(os.environ.get("OWNER_ID", "6252224878"))
BOT_USERNAME = os.environ.get("BOT_USERNAME", "Taj_Parsian_Bot")
API = f"https://api.telegram.org/bot{TOKEN}"
ARCHIVE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kavan_archive.jsonl")

app = Flask(__name__)
_lock = threading.Lock()


def tg(method: str, **params) -> dict:
    try:
        r = requests.post(f"{API}/{method}", json=params, timeout=30)
        return r.json()
    except Exception as exc:
        print("tg error:", exc)
        return {"ok": False}


def archive(update: dict) -> None:
    try:
        with _lock:
            with open(ARCHIVE, "a", encoding="utf-8") as f:
                f.write(json.dumps(update, ensure_ascii=False) + "\n")
    except Exception as exc:
        print("archive error:", exc)


def stats_line() -> int:
    try:
        return sum(1 for _ in open(ARCHIVE, encoding="utf-8"))
    except FileNotFoundError:
        return 0


def extract_mentions(msg: dict) -> list[str]:
    """Usernames found in the message text/entities."""
    out = []
    text = msg.get("text") or ""
    for ent in msg.get("entities", []):
        if ent.get("type") == "mention":
            out.append(text[ent["offset"]: ent["offset"] + ent["length"]])
    return out


PERSONA_GREETINGS = [
    "سلام، کاوانم 👋 چه خبر؟",
    "به‌به، کی باشه جز من 😎 بگو ببینم چی می‌خوای؟",
    "درخدمتم 🌹 بگو.",
]
PERSONA_UNKNOWN = [
    "جالب می‌گی 👀 ادامه بده...",
    "اوهوم، خودمم به این فکر کرده بودم 😄",
    "راستش دیروز داشتم به همین فکر می‌کردم! بیشتر بگو",
    "خب این یعنی چی حالا؟ 😅 توضیح بده رفیق",
]
OWNER_TAG_UNKNOWN = (
    "رئیس، {name} رو از وقتی من آنلاینم ندیدم پیام بده و تلگرام لیست اعضا رو به بات نمی‌ده 👀\n"
    "آیدی‌ش (@username) رو بده تا همین الان تگش کنم 🌹"
)


def send_panel(chat_id: int, reply_to: int | None = None) -> None:
    count = tg("getChatMemberCount", chat_id=chat_id).get("result", "?")
    kb = {
        "inline_keyboard": [
            [
                {"text": "🔄 بروزرسانی", "callback_data": "panel_refresh"},
                {"text": "👑 ادمین‌ها", "callback_data": "panel_admins"},
            ],
            [{"text": "📡 وضعیت", "callback_data": "panel_status"}],
        ]
    }
    admins = tg("getChatAdministrators", chat_id=chat_id).get("result", [])
    admin_names = []
    for a in admins:
        u = a.get("user", {})
        nm = "Group" if (u.get("is_bot") and u.get("first_name") == "Group") else u.get("first_name", "?")
        admin_names.append(("👑 " if a["status"] == "creator" else "🛡 ") + nm)
    text = (
        "👑 پنل کاوان\n\n"
        f"👥 اعضا: {count}\n"
        f"🛡 ادمین‌ها: {len(admins)}\n"
        f"🔍 رویدادهای آرشیوشده: {stats_line()}\n"
        f"🕒 {datetime.now().strftime('%H:%M:%S')}\n\n"
        + "\n".join(admin_names)
    )
    params = {"chat_id": chat_id, "text": text, "reply_markup": kb}
    if reply_to:
        params["reply_to_message_id"] = reply_to
        params["allow_sending_without_reply"] = True
    tg("sendMessage", **params)


def handle_group(msg: dict) -> None:
    frm = msg.get("from") or {}
    text = (msg.get("text") or "").strip()
    reply_to = msg.get("reply_to_message") or {}
    addressed = f"@{BOT_USERNAME}" in text or reply_to.get("from", {}).get("id") == BOT_SELF_ID
    if not addressed or not text:
        return

    chat_id = msg["chat"]["id"]
    is_owner = frm.get("id") == OWNER_ID

    if is_owner:
        low = text.replace(f"@{BOT_USERNAME}", "").strip()
        if low.startswith("تگ "):
            name = low[3:].strip().lstrip("@")
            mentions = extract_mentions(msg)
            if mentions:
                tg("sendMessage", chat_id=chat_id, text=f"فرمود رئیس 🌹 {mentions[0]} اومد اینجا 👆")
            else:
                tg("sendMessage", chat_id=chat_id, text=OWNER_TAG_UNKNOWN.format(name=name or "این نفر"))
            return
        if "پنل" in low:
            send_panel(chat_id, reply_to=msg.get("message_id"))
            return

    if text.rstrip().endswith("؟") or any(w in text for w in ("سلام", "خوبی", "چطوری", "هستی")):
        tg("sendMessage", chat_id=chat_id, reply_to_message_id=msg.get("message_id"),
           text=random.choice(PERSONA_GREETINGS))
    else:
        tg("sendMessage", chat_id=chat_id, reply_to_message_id=msg.get("message_id"),
           text=random.choice(PERSONA_UNKNOWN))


def handle_private(msg: dict) -> None:
    frm = msg.get("from") or {}
    if frm.get("id") != OWNER_ID:
        tg("sendMessage", chat_id=msg["chat"]["id"],
           text="سلام! من کاوانم 🌹 پیامت رسید، به زودی جواب می‌دم 😊")
        return
    send_panel(msg["chat"]["id"], reply_to=msg.get("message_id"))


def handle_callback(cb: dict) -> None:
    data = cb.get("data", "")
    msg = cb.get("message") or {}
    chat_id = msg.get("chat", {}).get("id")
    tg("answerCallbackQuery", callback_query_id=cb.get("id"))
    if not chat_id:
        return
    if data == "panel_refresh":
        send_panel(chat_id)
    elif data == "panel_admins":
        admins = tg("getChatAdministrators", chat_id=chat_id).get("result", [])
        lines = []
        for a in admins:
            u = a.get("user", {})
            nm = "Group" if (u.get("is_bot") and u.get("first_name") == "Group") else u.get("first_name", "?")
            un = f" (@{u['username']})" if u.get("username") else ""
            tag = "👑 سازنده" if a["status"] == "creator" else "🛡 ادمین"
            lines.append(f"{tag}: {nm}{un}")
        tg("sendMessage", chat_id=chat_id, text="\n".join(lines) or "ادمینی پیدا نشد")
    elif data == "panel_status":
        tg("sendMessage", chat_id=chat_id,
           text=f"📡 کاوان آنلاین و بیداره 👀\n🔍 {stats_line()} رویداد آرشیو شده\n🕒 {datetime.now().strftime('%H:%M:%S')}")


@app.get("/")
def health():
    return "کاوان آنلاینه ✅", 200


@app.post("/webhook")
def webhook():
    update = request.get_json(force=True, silent=True) or {}
    try:
        archive(update)
        if "callback_query" in update:
            handle_callback(update["callback_query"])
        elif "message" in update:
            msg = update["message"]
            chat_type = msg.get("chat", {}).get("type")
            if chat_type in ("group", "supergroup"):
                handle_group(msg)
            elif chat_type == "private":
                handle_private(msg)
    except Exception as exc:
        print("webhook error:", exc)
    return "ok", 200


BOT_SELF_ID = None
if __name__ == "__main__":
    me = tg("getMe").get("result", {})
    BOT_SELF_ID = me.get("id")
    print("bot:", me.get("username"), "id:", BOT_SELF_ID)
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 10000)))
