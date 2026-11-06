// server.js — 2ndBrain AI
// Serves the single-page app and exposes:
//   POST /api/analyze   -> { category, overview, keyTakeaways, actionableSteps, ... }
//   POST /api/publish   -> creates a Google Doc + sends it to Telegram

import "dotenv/config";
import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getVideoContext, AppError } from "./lib/context.js";
import { analyzeContent } from "./lib/gemini.js";
import { buildTelegramMessages } from "./lib/format.js";
import { appendSummaryToDoc } from "./lib/gdocs.js";
import { sendToTelegram } from "./lib/telegram.js";
import { setupTelegramBot } from "./lib/telegram-bot.js";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" })); // publish payload now carries the full transcript

// Lightweight health check for the host (no password, no secrets).
app.get("/healthz", (_req, res) => res.send("ok"));

// Telegram webhook route (hosted mode) — registered before the password check
// because Telegram can't log in; it's protected by its own secret instead.
const telegramBot = setupTelegramBot(app);

// Once the app is on the public internet, anyone could open the web page and
// use it to write into your Google Doc. If WEB_UI_PASSWORD is set, the page and
// its API ask for that password (any username works).
const WEB_UI_PASSWORD = process.env.WEB_UI_PASSWORD || "";
if (WEB_UI_PASSWORD) {
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.get("Authorization") || "").split(" ");
    if (scheme === "Basic" && encoded) {
      const pass = Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":");
      const a = Buffer.from(pass);
      const b = Buffer.from(WEB_UI_PASSWORD);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="EZnotes"').status(401).send("Password required.");
  });
}

app.use(express.static(path.join(__dirname, "public")));

// --- Analyze a video link ---------------------------------------------------
app.post("/api/analyze", async (req, res) => {
  try {
    const { url } = req.body || {};
    const context = await getVideoContext(url);
    const analysis = await analyzeContent(context);

    res.json({
      ok: true,
      ...analysis,
      videoTitle: context.title,
      platform: context.platform,
      sourceUsed: analysis.sourceUsed, // "transcript" | "video" | "metadata"
      url: (url || "").trim(),
    });
  } catch (err) {
    handleError(res, err);
  }
});

// --- Save to Google Docs + send to Telegram ---------------------------------
app.post("/api/publish", async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.overview && !(data.keyTakeaways || []).length) {
      throw new AppError(400, "There's nothing to publish yet. Analyze a video first.");
    }

    // 1) Append to the master Google Doc (hard requirement).
    const { url: docUrl } = await appendSummaryToDoc(data);

    // 2) Send to Telegram (soft: if it fails, the doc still succeeded).
    let telegram = true;
    let telegramError = null;
    try {
      await sendToTelegram(buildTelegramMessages(data, docUrl));
    } catch (err) {
      telegram = false;
      telegramError = err instanceof AppError ? err.message : "Telegram send failed.";
    }

    res.json({ ok: true, docUrl, telegram, telegramError });
  } catch (err) {
    handleError(res, err);
  }
});

function handleError(res, err) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ ok: false, error: err.message });
  }
  console.error("Unexpected error:", err);
  res.status(500).json({
    ok: false,
    error: "Something went wrong on the server. Please try again.",
  });
}

app.listen(PORT, () => {
  console.log(`\n  2ndBrain AI running →  http://localhost:${PORT}\n`);
  const missing = [];
  if (!process.env.GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
  const hasServiceAccount =
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH &&
      existsSync(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH)) ||
    existsSync(path.join(__dirname, "service-account.json"));
  if (!hasServiceAccount) missing.push("service-account.json (Google Docs)");
  if (!process.env.GOOGLE_DOC_ID) missing.push("GOOGLE_DOC_ID (master doc)");
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    missing.push("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID");
  }
  if (missing.length) {
    console.warn("  ⚠  Not configured yet: " + missing.join(", ") + "\n");
  }

  // Start the Telegram bot (webhook when hosted, polling on your PC).
  telegramBot.start();
});
