// lib/telegram.js
// Sends a message to a Telegram chat via the Bot API.

import { AppError } from "./context.js";

/** Send one HTML message, or an array of them in order. */
export async function sendToTelegram(htmlMessage) {
  if (Array.isArray(htmlMessage)) {
    for (const m of htmlMessage) await sendOne(m);
    return true;
  }
  return sendOne(htmlMessage);
}

async function sendOne(htmlMessage) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new AppError(
      500,
      "Telegram isn't configured. Add TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_CHAT_ID to your .env file. See the README."
    );
  }

  let res, data;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: htmlMessage,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    });
    data = await res.json().catch(() => ({}));
  } catch {
    throw new AppError(502, "Couldn't reach Telegram. Check your internet connection.");
  }

  if (!res.ok || !data.ok) {
    const desc = data.description || `HTTP ${res.status}`;
    if (/chat not found/i.test(desc)) {
      throw new AppError(
        502,
        "Telegram says 'chat not found'. Open a chat with your bot, send it any message, then set TELEGRAM_CHAT_ID to your numeric chat id (see README)."
      );
    }
    if (/unauthorized|not found|bot token/i.test(desc)) {
      throw new AppError(
        502,
        "Telegram rejected the bot token. Double-check TELEGRAM_BOT_TOKEN from @BotFather."
      );
    }
    throw new AppError(502, `Telegram error: ${desc}`);
  }
  return true;
}
