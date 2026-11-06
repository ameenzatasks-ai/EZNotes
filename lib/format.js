// lib/format.js
// Builds the HTML-formatted Telegram message(s) from an analysis result.
// Layout: Title & Subtitle → Full Transcription → Key Takeaways → Actionable Steps.
// A full transcription is usually longer than Telegram's 4096-char limit, so the
// output is split into several messages on paragraph boundaries.

const TG_LIMIT = 4000; // a little under Telegram's 4096 to be safe

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Accepts {a,b} objects or legacy plain strings. */
const pair = (item, keyA, keyB) =>
  item && typeof item === "object"
    ? { a: item[keyA] || "", b: item[keyB] || "" }
    : { a: "", b: String(item ?? "") };

/** Ordered list of HTML blocks (each block = one paragraph). */
function buildBlocks(data, docUrl) {
  const {
    title,
    videoTitle = "Video Notes",
    subtitle,
    overview = "",
    category = "Interesting Stuff",
    transcript = [],
    keyTakeaways = [],
    actionableSteps = [],
    sourceUsed,
    url = "",
  } = data || {};

  const blocks = [];

  // 1. Title & Subtitle
  blocks.push(
    `<b>🧠 ${escapeHtml(title || videoTitle)}</b>\n<i>${escapeHtml(
      subtitle || overview || ""
    )}</i>\n🏷 ${escapeHtml(category)}`
  );

  // 2. Full Transcription
  blocks.push("<b>📝 FULL TRANSCRIPTION</b>");
  if (transcript.length) {
    transcript.forEach((sec) => {
      if (sec.heading) blocks.push(`<b><u>${escapeHtml(sec.heading)}</u></b>`);
      (sec.paragraphs || []).forEach((p) => {
        const label = p.speaker ? `<b>${escapeHtml(p.speaker)}:</b> ` : "";
        blocks.push(label + escapeHtml(p.text));
      });
    });
  } else {
    blocks.push(
      `<i>${
        sourceUsed === "metadata"
          ? "No captions were available for this video, so a full transcription couldn't be produced."
          : "No transcription available."
      }</i>`
    );
  }

  // 3. Key Takeaways
  if (keyTakeaways.length) {
    blocks.push("<b>💡 KEY TAKEAWAYS</b>");
    keyTakeaways.forEach((t) => {
      const { a, b } = pair(t, "concept", "detail");
      blocks.push(`• ${a ? `<b>${escapeHtml(a)}:</b> ` : ""}${escapeHtml(b)}`);
    });
  }

  // 4. Actionable Steps
  if (actionableSteps.length) {
    blocks.push("<b>✅ ACTIONABLE STEPS</b>");
    actionableSteps.forEach((s, i) => {
      const { a, b } = pair(s, "action", "detail");
      blocks.push(
        `${i + 1}. ${a ? `<b>${escapeHtml(a)}</b>` : ""}${a && b ? " — " : ""}${escapeHtml(b)}`
      );
    });
  }

  const links = [];
  if (docUrl) links.push(`📄 <a href="${escapeHtml(docUrl)}">Open in Google Docs</a>`);
  if (url) links.push(`🔗 <a href="${escapeHtml(url)}">Original video</a>`);
  if (links.length) blocks.push(links.join("\n"));

  return blocks;
}

/** Split a block that alone exceeds the limit, at whitespace. */
function splitLong(block) {
  const parts = [];
  let rest = block;
  while (rest.length > TG_LIMIT) {
    let cut = rest.lastIndexOf(" ", TG_LIMIT);
    if (cut < TG_LIMIT / 2) cut = TG_LIMIT;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Pack blocks into as few messages as possible, each under the limit. */
function packMessages(blocks) {
  const messages = [];
  let cur = "";
  for (const block of blocks.flatMap(splitLong)) {
    const next = cur ? cur + "\n\n" + block : block;
    if (next.length > TG_LIMIT) {
      messages.push(cur);
      cur = block;
    } else {
      cur = next;
    }
  }
  if (cur) messages.push(cur);
  return messages;
}

/** Telegram messages (parse_mode: HTML), in send order. */
export function buildTelegramMessages(data, docUrl) {
  return packMessages(buildBlocks(data, docUrl));
}
