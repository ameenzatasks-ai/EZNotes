// lib/telegram-bot.js
// Runs the 2ndBrain pipeline FROM Telegram: the user sends a video link to the
// bot, and the bot replies with the summary (and also saves it to the Doc).
// Uses long-polling (getUpdates) so it works locally with no public URL.

import crypto from "node:crypto";
import { getVideoContext, AppError } from "./context.js";
import { analyzeContent } from "./gemini.js";
import { appendSummaryToDoc } from "./gdocs.js";
import { buildTelegramMessages, escapeHtml } from "./format.js";

const apiUrl = (token, method) =>
  `https://api.telegram.org/bot${token}/${method}`;

async function callTelegram(token, method, body, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl(token, method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function extractUrl(text) {
  const m = (text || "").match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : null;
}

/**
 * Handle one inbound text message. Exported so it can be tested directly.
 * Sends replies into the chat via the bot.
 */
export async function processIncomingText(token, chatId, text, { saveToDoc = true } = {}) {
  const send = (t, preview = false) =>
    callTelegram(token, "sendMessage", {
      chat_id: chatId,
      text: t,
      parse_mode: "HTML",
      disable_web_page_preview: !preview,
    });

  const trimmed = (text || "").trim();

  if (trimmed === "/start" || trimmed === "/help") {
    await send(
      "👋 <b>EZnotes</b>\nSend me a <b>YouTube</b> or <b>Facebook</b> video link and I'll summarize it, save it to your Google Doc, and reply here with the takeaways."
    );
    return;
  }

  const url = extractUrl(trimmed);
  if (!url) {
    await send("Send me a YouTube or Facebook video link and I'll do the rest. 🔗");
    return;
  }

  await send("🔍 Got it — fetching the transcript and summarizing…");

  try {
    const context = await getVideoContext(url);
    const analysis = await analyzeContent(context);
    const data = { ...analysis, videoTitle: context.title, sourceUsed: analysis.sourceUsed, url };

    // Save to the Doc and send the notes to Telegram at the same time. The Doc
    // link is known up front (it's always the same master doc).
    const docId = (process.env.GOOGLE_DOC_ID || "").trim();
    const docUrl =
      saveToDoc && docId ? `https://docs.google.com/document/d/${docId}/edit` : null;
    const docSave = saveToDoc
      ? appendSummaryToDoc(data).then(
          () => null,
          (e) => (e instanceof AppError ? e.message : "Couldn't save to the Google Doc.")
        )
      : Promise.resolve(undefined);

    // Send in order so the notes read top-to-bottom in the chat.
    for (const m of buildTelegramMessages(data, docUrl)) await send(m);

    const docError = await docSave;
    if (docError === null) await send("✅ <i>Saved to your EZnotes doc.</i>");
    else if (docError) await send(`⚠ <i>${escapeHtml(docError)}</i>`);
  } catch (err) {
    const msg =
      err instanceof AppError
        ? err.message
        : "Something went wrong. Please try again.";
    await send("⚠ " + msg);
  }
}

const WEBHOOK_PATH = "/telegram/webhook";

/**
 * Wire up the Telegram bot. Two modes:
 *
 * - WEBHOOK (hosted): when WEBHOOK_URL is set (or RENDER_EXTERNAL_URL, which
 *   Render sets automatically), Telegram POSTs each message to
 *   <url>/telegram/webhook. That incoming request is also what wakes a
 *   free-tier host that has gone to sleep.
 * - POLLING (local): otherwise the app asks Telegram for new messages in a loop,
 *   which works on your own PC with no public URL.
 *
 * Call this BEFORE any auth middleware (it registers the webhook route), then
 * call the returned start() once the server is listening.
 */
export function setupTelegramBot(app) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ownerChat = process.env.TELEGRAM_CHAT_ID
    ? String(process.env.TELEGRAM_CHAT_ID)
    : null;
  const isPublic = /^true$/i.test(process.env.BOT_PUBLIC || "");
  const mode = isPublic ? "PUBLIC — anyone can use it" : "private — owner only";

  if (!token) {
    return {
      start() {
        console.warn("  📨 Telegram bot not started (TELEGRAM_BOT_TOKEN missing).\n");
      },
    };
  }

  async function handleUpdate(upd) {
    const msg = upd.message;
    if (!msg || !msg.text) return;
    const chatId = String(msg.chat.id);
    const isOwner = !ownerChat || chatId === ownerChat;

    // Private mode: only the owner may use the bot.
    if (!isPublic && !isOwner) {
      await callTelegram(token, "sendMessage", {
        chat_id: chatId,
        text: "Sorry — this is a private bot.",
      });
      return;
    }
    // In public mode everyone gets summaries, but only the owner's requests are
    // saved to the owner's personal Google Doc.
    await processIncomingText(token, chatId, msg.text, { saveToDoc: isOwner });
  }

  // ---- Webhook mode --------------------------------------------------------
  const base = (process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || "")
    .trim()
    .replace(/\/+$/, "");

  if (base) {
    // Telegram echoes this secret in a header, so random visitors can't post
    // fake updates to the webhook URL.
    const secret = crypto.createHash("sha256").update("eznotes:" + token).digest("hex").slice(0, 48);
    const seen = new Set(); // Telegram may retry an update; handle each once.

    app.post(WEBHOOK_PATH, (req, res) => {
      if (req.get("X-Telegram-Bot-Api-Secret-Token") !== secret) return res.sendStatus(401);
      // Answer straight away; the summary is sent as separate messages later.
      res.sendStatus(200);
      const upd = req.body;
      if (!upd || typeof upd.update_id !== "number" || seen.has(upd.update_id)) return;
      seen.add(upd.update_id);
      if (seen.size > 1000) seen.delete(seen.values().next().value);
      handleUpdate(upd).catch((e) => console.error("Telegram handler error:", e?.message || e));
    });

    return {
      async start() {
        const r = await callTelegram(token, "setWebhook", {
          url: base + WEBHOOK_PATH,
          secret_token: secret,
          allowed_updates: ["message"],
        }).catch((e) => ({ ok: false, description: e?.message || String(e) }));
        if (r.ok) console.log(`  📨 Telegram bot ready via webhook (${mode}).\n`);
        else console.error(`  ⚠ Couldn't register the Telegram webhook: ${r.description}\n`);
      },
    };
  }

  // ---- Polling mode --------------------------------------------------------
  let running = true;
  let offset = 0;

  async function loop() {
    // If a hosted copy has registered a webhook, polling here would either
    // fail or steal its messages. Leave the hosted copy in charge.
    try {
      const info = await callTelegram(token, "getWebhookInfo", {});
      if (info.ok && info.result.url && !/^true$/i.test(process.env.FORCE_POLLING || "")) {
        console.warn(
          `  📨 Telegram bot NOT started here: the bot is already hosted online (${info.result.url}).\n` +
            "     Messages go to the hosted copy. To run it on this PC instead, set FORCE_POLLING=true\n" +
            "     (this switches Telegram away from the hosted copy until that copy restarts).\n"
        );
        return;
      }
      if (info.ok && info.result.url) await callTelegram(token, "deleteWebhook", {});
    } catch {
      /* ignore — fall through to polling */
    }

    // Drain any old/pending updates so we don't replay them on startup.
    try {
      const drained = await callTelegram(token, "getUpdates", { timeout: 0 });
      if (drained.ok && drained.result.length) {
        offset = drained.result[drained.result.length - 1].update_id + 1;
      }
    } catch {
      /* ignore */
    }

    console.log(`  📨 Telegram bot listening (${mode}).\n`);

    while (running) {
      try {
        const res = await callTelegram(token, "getUpdates", {
          offset,
          timeout: 50,
          allowed_updates: ["message"],
        });
        if (!res.ok) {
          // e.g. 409 = another copy of the bot is already polling; 401 = bad token.
          console.error(`Telegram getUpdates failed: ${res.error_code} ${res.description}`);
          await new Promise((r) => setTimeout(r, 5000));
        } else if (Array.isArray(res.result)) {
          for (const upd of res.result) {
            offset = upd.update_id + 1;
            try {
              await handleUpdate(upd);
            } catch (e) {
              console.error("Telegram handler error:", e?.message || e);
            }
          }
        }
      } catch {
        // Network hiccup / abort — pause briefly and retry.
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  return {
    start() {
      loop();
    },
    stop() {
      running = false;
    },
  };
}
