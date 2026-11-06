# 2ndBrain AI

Paste a **YouTube** or **Facebook** video link → 2ndBrain AI fetches the
transcript (or page context), uses **Google Gemini** to categorize it and write
a clean summary with key takeaways, then **saves it as a Google Doc** and
**sends it to your Telegram** automatically.

## Categories

Every video is sorted into exactly one bucket:

`Motivational` · `Islamic reminders` · `Strategic development` · `AI Strategy` · `Websites` · `Interesting Stuff` · `IT`

---

## Quick start

### 👶 First time? Start here:
1. **[SETUP_GUIDE_FOR_NOVICES.md](SETUP_GUIDE_FOR_NOVICES.md)** — complete beginner's guide (30–45 minutes, no coding knowledge needed)
2. **[QUICK_SETUP_CHECKLIST.md](QUICK_SETUP_CHECKLIST.md)** — print this and use it while following the guide
3. **[TROUBLESHOOTING_DETAILED.md](TROUBLESHOOTING_DETAILED.md)** — if something breaks, find the fix here

### Experienced developers:
```bash
npm install
# create .env (see below), then:
npm start
```

Open **http://localhost:3000**.

You configure three things in a `.env` file (copy `.env.example`): **Gemini**,
**Google Docs**, and **Telegram**. The hero/analysis works with just Gemini; the
"Save & send" button needs the other two.

---

## 1) Gemini (AI analysis) — required

1. Get a free key at **https://aistudio.google.com/apikey**
2. In `.env`:
   ```
   GEMINI_API_KEY=your_key_here
   ```

## 2) Google Docs setup — required for "Save to Google Docs"

Summaries are **appended to one master Google Doc** you own. A **service account**
(robot login) does the writing. We append to an existing doc rather than creating
new ones because a service account has no Drive storage of its own — so on a
personal Gmail it can't *create* a Doc, but it *can* edit one you share with it.

1. Go to **https://console.cloud.google.com/** → create (or pick) a project.
2. **APIs & Services → Library →** enable the **Google Docs API**.
3. **APIs & Services → Credentials → Create credentials → Service account.**
   Create it, then open it → **Keys → Add key → JSON** → download the file.
4. Save that file in this project folder as **`service-account.json`**.
5. Create a Google Doc (e.g. at https://docs.new), name it "2ndBrain Notes",
   then **Share** it with the service account's email (the `client_email` in the
   JSON, ending in `…iam.gserviceaccount.com`) as **Editor**.
6. Copy the doc's ID from its URL — `docs.google.com/document/d/<THIS_PART>/edit`
   — and put it in `.env`:
   ```
   GOOGLE_DOC_ID=your_doc_id_here
   ```

> Each new summary is inserted at the **top** of this doc (newest first).

## 3) Telegram setup — required for auto-send

1. In Telegram, message **@BotFather** → `/newbot` → copy the **bot token**.
2. Open a chat with your new bot and **send it any message** (e.g. "hi").
3. Get your chat id: visit
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` and copy the
   `"chat":{"id": ... }` number.
4. In `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_CHAT_ID=987654321
   ```

You can also drive the whole app **from Telegram**: send the bot a video link and
it replies with the summary (and saves it to your Doc). It listens while the app
is running (`npm start`).

### Make the bot public & always-on

By default the bot only answers you. To let **anyone** use it, set:
```
BOT_PUBLIC=true
```
Everyone who messages the bot then gets summaries, but **only your chat writes to
your Google Doc** (strangers can't pollute your personal notes).

**For a public bot to work 24/7**, deploy it to a cloud host (no PC needed):
- **[DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)** — step-by-step (Railway recommended, free tier, 10 min setup)
- Deploy to Railway, Render, Fly.io, or DigitalOcean
- Bot runs forever (even if your PC is off)
- Cost: Free to $7/month depending on platform

If you skip deployment, the bot only works when `npm start` is running on your PC.

## App icon

The logo lives at `public/logo.svg` (brand colors: midnight violet, electric
lime, hot pink). Regenerate the PNG icons any time with:
```
node scripts/make-icons.mjs
```
This writes `public/icon-512.png` (for the Telegram bot picture via @BotFather →
`/setuserpic`), plus the web favicons. The web app and Telegram bot share the
same artwork.

---

## How it works

```
Browser ──POST /api/analyze──▶ Express
                                 1. transcript (youtube-transcript) or OG meta
                                 2. Gemini → { category, summary, takeaways }
                               ◀─ JSON result shown on screen

Browser ──POST /api/publish──▶ Express
                                 1. append formatted summary to master Doc
                                    (Docs API batchUpdate, newest on top)
                                 2. Telegram Bot API sends summary + Doc link
                               ◀─ { docUrl, telegram: true }
```

If the Doc append succeeds but Telegram fails (or isn't configured yet), you
still get the Doc link and a clear warning — the two steps fail independently.

## Notes & limits

- **YouTube** works best with captions; otherwise it falls back to title +
  description and the AI is told to stay cautious. The result labels its source.
- **Facebook** must be a **public** video; private/login-walled ones return a
  friendly error.
- Nothing is stored on the server — each analysis is processed in-memory.

## Project structure

```
server.js            Express app + routes (/api/analyze, /api/publish)
lib/context.js       Transcript / page-context fetching + error handling
lib/gemini.js        Gemini prompt + structured analysis
lib/format.js        Builds the Telegram message
lib/gdocs.js         Appends the summary to the master Google Doc (Docs API)
lib/telegram.js      Sends the Telegram message
public/              Single-page UI (index.html, styles.css, app.js)
```
