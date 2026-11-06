// lib/gdocs.js
// Appends a formatted summary to an existing "master" Google Doc that the user
// owns and has shared with the service account as Editor.
//
// Why append instead of create: a service account has no Drive storage of its
// own, so on a personal Gmail it can't *create* a Doc. Editing an existing
// user-owned Doc has no such limit.

import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { AppError } from "./context.js";

let authClient = null;
const cachedTab = { docId: null, tabId: null };

function loadCredentials() {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch {
      throw new AppError(500, "GOOGLE_SERVICE_ACCOUNT_JSON isn't valid JSON.");
    }
  }
  const keyPath =
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ||
    path.join(process.cwd(), "service-account.json");
  if (!fs.existsSync(keyPath)) {
    throw new AppError(
      500,
      "Google isn't configured. Add service-account.json to the project. See the README."
    );
  }
  try {
    return JSON.parse(fs.readFileSync(keyPath, "utf8"));
  } catch {
    throw new AppError(500, "service-account.json isn't valid JSON.");
  }
}

function getAuth() {
  if (!authClient) {
    authClient = new google.auth.GoogleAuth({
      credentials: loadCredentials(),
      scopes: ["https://www.googleapis.com/auth/documents"],
    });
  }
  return authClient;
}

// Location/Range helpers that include a tabId when the doc uses tabs.
const loc = (index, tabId) => (tabId ? { index, tabId } : { index });
const rng = (startIndex, endIndex, tabId) =>
  tabId ? { startIndex, endIndex, tabId } : { startIndex, endIndex };

const GRAY = { color: { rgbColor: { red: 0.42, green: 0.37, blue: 0.55 } } };

// Visual hierarchy. namedStyleType drives the doc outline; fontSize is set
// explicitly so the size difference is guaranteed regardless of the doc theme.
const STYLES = {
  // Only the video title is a real heading, so the Doc's outline lists just
  // one entry per video. Everything else is normal text styled to look right.
  h1: { named: "HEADING_1", text: { bold: true, fontSize: 20 } }, // video title
  h3sub: { named: "NORMAL_TEXT", text: { bold: false, italic: true, fontSize: 12.5, gray: true } }, // subtitle
  sub: { named: "NORMAL_TEXT", text: { italic: true, fontSize: 9.5, gray: true } }, // date · category
  h2: { named: "NORMAL_TEXT", text: { bold: true, italic: false, fontSize: 15 } }, // Key Takeaways / Actionable Steps
  h4: { named: "NORMAL_TEXT", text: { bold: true, italic: false, fontSize: 11 } }, // transcript section titles
  link: { named: "NORMAL_TEXT", text: { bold: false, italic: false, fontSize: 11 } }, // link to the video
  body: { named: "NORMAL_TEXT", text: { bold: false, italic: false, fontSize: 11 } }, // paragraphs / list items
  src: { named: "NORMAL_TEXT", text: { italic: true, fontSize: 9.5, gray: true } }, // source line
  rule: { named: "NORMAL_TEXT", text: { bold: false, fontSize: 11, gray: true } }, // divider
};

function textStyleRequest(range, st) {
  const textStyle = {};
  const fields = [];
  if (st.bold !== undefined) {
    textStyle.bold = !!st.bold;
    fields.push("bold");
  }
  if (st.italic !== undefined) {
    textStyle.italic = !!st.italic;
    fields.push("italic");
  }
  if (st.fontSize !== undefined) {
    textStyle.fontSize = { magnitude: st.fontSize, unit: "PT" };
    fields.push("fontSize");
  }
  if (st.gray) {
    textStyle.foregroundColor = GRAY;
    fields.push("foregroundColor");
  }
  return { updateTextStyle: { range, textStyle, fields: fields.join(",") } };
}

/**
 * Build batchUpdate requests that insert a formatted summary block at the very
 * top of the doc (newest first). Returns the request array.
 */
/** Accepts {a,b} objects or legacy plain strings. */
const pair = (item, keyA, keyB) =>
  item && typeof item === "object"
    ? { a: String(item[keyA] || ""), b: String(item[keyB] || "") }
    : { a: "", b: String(item ?? "") };

// Docs text can't contain raw control chars; collapse stray newlines too so one
// logical paragraph stays one Docs paragraph.
const clean = (s) => String(s ?? "").replace(/[\r\n\v\f]+/g, " ").replace(/[\u0000-\u0008\u000e-\u001f]/g, "");

export function buildRequests(data, startIndex, tabId) {
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

  // Each line: { text, style, bold?: number of leading chars to bold, list?: "bullet"|"number" }
  const lines = [];
  const add = (text, style, extra = {}) => lines.push({ text: clean(text), style, ...extra });

  // 1. Title & Subtitle
  add(title || videoTitle, "h1");
  if (subtitle || overview) add(subtitle || overview, "h3sub");
  add(`${new Date().toLocaleDateString()}  ·  ${category}`, "sub");
  add("", "body");

  // 2. Full transcription (no section label — it follows the subtitle directly)
  if (transcript.length) {
    transcript.forEach((sec) => {
      if (sec.heading) add(sec.heading, "h4");
      (sec.paragraphs || []).forEach((p) => {
        const label = p.speaker ? clean(p.speaker) + ": " : "";
        add(label + p.text, "body", { bold: label.length });
      });
    });
  } else {
    add(
      sourceUsed === "metadata"
        ? "No captions were available for this video, so a full transcription couldn't be produced."
        : "No transcription available.",
      "src"
    );
  }
  add("", "body");

  // 3. Key Takeaways (bulleted, bold core concept)
  if (keyTakeaways.length) {
    add("Key Takeaways", "h2");
    keyTakeaways.forEach((t) => {
      const { a, b } = pair(t, "concept", "detail");
      const head = a ? clean(a) + ": " : "";
      add(head + b, "body", { bold: head.length, list: "bullet" });
    });
    add("", "body");
  }

  // 4. Actionable Steps (numbered, bold imperative step)
  if (actionableSteps.length) {
    add("Actionable Steps", "h2");
    actionableSteps.forEach((s) => {
      const { a, b } = pair(s, "action", "detail");
      const head = a ? clean(a) + (b ? " — " : "") : "";
      add(head + b, "body", { bold: a ? clean(a).length : 0, list: "number" });
    });
    add("", "body");
  }

  if (url) add("▶ Watch the original video", "link", { link: url });
  add("──────────────────────────────", "rule");
  add("", "body");

  // Concatenate with newlines, tracking index ranges per line.
  let full = "";
  const segs = [];
  let idx = startIndex;
  for (const ln of lines) {
    const withNl = ln.text + "\n";
    segs.push({
      ...ln,
      textStart: idx,
      textEnd: idx + ln.text.length,
      paraStart: idx,
      paraEnd: idx + withNl.length,
      empty: ln.text.length === 0,
    });
    full += withNl;
    idx += withNl.length;
  }

  const requests = [
    { insertText: { location: loc(startIndex, tabId), text: full } },
  ];

  for (const s of segs) {
    const st = STYLES[s.style] || STYLES.body;
    // Always set the paragraph's named style — this prevents inserted lines
    // from inheriting the heading style of whatever sat at the insert point.
    requests.push({
      updateParagraphStyle: {
        range: rng(s.paraStart, s.paraEnd, tabId),
        paragraphStyle: { namedStyleType: s.empty ? "NORMAL_TEXT" : st.named },
        fields: "namedStyleType",
      },
    });
    if (!s.empty) {
      requests.push(textStyleRequest(rng(s.textStart, s.textEnd, tabId), st.text));
      if (s.bold) {
        requests.push(
          textStyleRequest(rng(s.textStart, s.textStart + s.bold, tabId), { bold: true })
        );
      }
      if (s.link) {
        requests.push({
          updateTextStyle: {
            range: rng(s.textStart, s.textEnd, tabId),
            textStyle: { link: { url: s.link } },
            fields: "link",
          },
        });
      }
    }
  }

  // Inserted text can inherit a list from the insert point — clear bullets on
  // everything first, then turn each run of consecutive list lines into a
  // real Docs list (bulleted or numbered).
  requests.push({
    deleteParagraphBullets: { range: rng(startIndex, idx, tabId) },
  });
  let run = null;
  const flush = () => {
    if (!run) return;
    requests.push({
      createParagraphBullets: {
        range: rng(run.start, run.end, tabId),
        bulletPreset:
          run.kind === "number" ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE",
      },
    });
    run = null;
  };
  for (const s of segs) {
    if (s.list && run && run.kind === s.list) run.end = s.paraEnd;
    else {
      flush();
      if (s.list) run = { kind: s.list, start: s.paraStart, end: s.paraEnd };
    }
  }
  flush();

  return requests;
}

async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const code = e?.code;
      // Don't retry permanent errors (auth/permission/not-found/bad-request).
      if ([400, 401, 403, 404].includes(code)) throw e;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * Appends the summary to the master doc (GOOGLE_DOC_ID).
 * @returns {Promise<{ url: string }>}
 */
export async function appendSummaryToDoc(data) {
  const docId = (process.env.GOOGLE_DOC_ID || "").trim();
  if (!docId) {
    throw new AppError(
      500,
      "GOOGLE_DOC_ID isn't set. Create a Google Doc, share it with the service account as Editor, and put its ID in .env. See the README."
    );
  }

  const docs = google.docs({ version: "v1", auth: getAuth() });

  try {
    await withRetry(async () => {
      // Resolve the first tab's id so writes target it explicitly. Without a
      // tabId, a write can silently land in an invisible legacy body.
      // Only the tab id is requested (not the whole doc's content, which grows
      // with every note), and it's cached after the first lookup.
      if (cachedTab.docId !== docId) {
        const doc = await docs.documents.get({
          documentId: docId,
          includeTabsContent: true,
          fields: "tabs(tabProperties(tabId))",
        });
        cachedTab.docId = docId;
        cachedTab.tabId = doc.data.tabs?.[0]?.tabProperties?.tabId || null;
      }
      const tabId = cachedTab.tabId;

      await docs.documents.batchUpdate({
        documentId: docId,
        // Always insert at index 1 (start of the body) — guaranteed valid.
        requestBody: { requests: buildRequests(data, 1, tabId) },
      });
    });
  } catch (err) {
    const msg = String(err?.message || err);
    const code = err?.code;
    if (code === 404 || /not found|requested entity was not found/i.test(msg)) {
      throw new AppError(
        502,
        "That Google Doc wasn't found — double-check GOOGLE_DOC_ID in .env."
      );
    }
    if (code === 403 || /permission|forbidden|insufficient/i.test(msg)) {
      if (/api has not been used|disabled|accessNotConfigured/i.test(msg)) {
        throw new AppError(
          502,
          "The Google Docs API isn't enabled for your project. Enable 'Google Docs API' in Google Cloud Console."
        );
      }
      throw new AppError(
        502,
        "The service account can't edit that Doc. Open the Doc → Share → add the service-account email as Editor."
      );
    }
    throw new AppError(502, "Couldn't write to the Google Doc. Please try again.");
  }

  return { url: `https://docs.google.com/document/d/${docId}/edit` };
}
