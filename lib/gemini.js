// lib/gemini.js
// Sends the transcript/context to Gemini and returns a structured result:
// { category, title, subtitle, transcript[{heading, paragraphs[{speaker, text}]}],
//   keyTakeaways[{concept, detail}], actionableSteps[{action, detail}] }.

import { GoogleGenAI } from "@google/genai";
import { AppError } from "./context.js";

export const CATEGORIES = [
  "Motivational",
  "Islamic reminders",
  "Strategic development",
  "AI Strategy",
  "Websites",
  "Interesting Stuff",
  "IT",
];

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
// Fallback used when the primary is overloaded (503) or rate-limited.
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash-lite";

let client = null;
function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AppError(
      500,
      "The server is missing its GEMINI_API_KEY. Add it to your .env file and restart the app."
    );
  }
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

// The full transcription needs the whole transcript, so only cap truly huge
// inputs (≈ 2+ hours of speech) to stay well inside the model's limits.
const MAX_INPUT_CHARS = 150000;

function buildPrompt({ title, sourceUsed, text }) {
  const content =
    text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) + "…" : text;
  const noTranscript = sourceUsed === "metadata";
  const fromVideo = sourceUsed === "video";

  return `You are an expert Content Architect, Lead Transcript Specialist, and Knowledge Manager. Your task is to process the provided video ${
    fromVideo ? "(attached — transcribe its spoken audio yourself)" : "transcript"
  }, produce an accurate, beautifully structured transcription, and synthesize its core value into actionable insights.

Follow this exact structure and protocol:

1. TITLE & SUBTITLE
- "title": An engaging, accurate main title capturing the primary theme of the video.
- "subtitle": A concise 1-2 sentence subtitle giving context on the video's core focus and target takeaway.

2. FULL TRANSCRIPTION ("transcript")
- Accuracy & clean formatting: provide a faithful, clean transcription of the spoken content. Do NOT include any timestamps.
- Readability: remove filler words (e.g. "um", "ah", "you know", "like") and fix minor false starts while preserving the speaker's tone, exact vocabulary, and key phrasing.
- Structure: break the transcription into logical sections, each with a short section title, starting a new section whenever the speaker transitions to a new concept or topic. Within a section, split the text into readable paragraphs.
- Attribution: if there are multiple speakers, label each paragraph with its speaker ("Speaker 1", "Speaker 2", or their name if identified). If there is only one speaker, leave "speaker" as an empty string.
- Cover the ENTIRE transcript from start to finish — do not summarize or skip parts.${
    noTranscript
      ? `\n- NOTE: No transcript was available for this video, only its title/description. Return "transcript" as an empty array [] and base everything else on the available information.`
      : ""
  }

3. KEY TAKEAWAYS ("keyTakeaways")
3 to 7 high-impact insights. For each:
- "concept": a bold summary phrase of 3-5 words.
- "detail": 1-2 sentences explaining WHY this insight matters and HOW it was presented in the video.

4. ACTIONABLE STEPS ("actionableSteps")
A sequential list of practical, real-world steps the viewer can take immediately based on the video's recommendations. For each:
- "action": a short step that starts with a strong imperative verb (e.g. Implement, Audit, Configure, Eliminate).
- "detail": the exact tool, method, or mindset shift required to execute the step effectively.

5. CATEGORY
Categorize the video into exactly ONE of: ${CATEGORIES.join(", ")}.

VIDEO TITLE: ${title || "Unknown"}

${
    noTranscript || fromVideo
      ? "VIDEO TITLE/DESCRIPTION" + (fromVideo ? " (extra context only — transcribe from the attached video)" : "")
      : "TRANSCRIPT"
  }:
${content}

OUTPUT strictly as JSON in this shape:
{
  "category": "<exact category>",
  "title": "<main title>",
  "subtitle": "<1-2 sentence subtitle>",
  "transcript": [
    { "heading": "<section title>", "paragraphs": [ { "speaker": "<speaker label or empty>", "text": "<clean paragraph>" } ] }
  ],
  "keyTakeaways": [ { "concept": "<3-5 word phrase>", "detail": "<1-2 sentences>" } ],
  "actionableSteps": [ { "action": "<imperative step>", "detail": "<tool / method / mindset shift>" } ]
}`;
}

function coerceCategory(value) {
  if (!value) return "Interesting Stuff";
  const found = CATEGORIES.find(
    (c) => c.toLowerCase() === String(value).trim().toLowerCase()
  );
  return found || "Interesting Stuff";
}

const str = (v) => (typeof v === "string" ? v.trim() : String(v ?? "").trim());

/** Normalise [{a, b}] (or plain strings) into [{[keyA], [keyB]}]. */
function toPairs(value, keyA, keyB) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) =>
      v && typeof v === "object"
        ? { [keyA]: str(v[keyA]), [keyB]: str(v[keyB]) }
        : { [keyA]: "", [keyB]: str(v) }
    )
    .filter((p) => p[keyA] || p[keyB]);
}

function toTranscript(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((sec) => ({
      heading: str(sec?.heading),
      paragraphs: (Array.isArray(sec?.paragraphs) ? sec.paragraphs : [])
        .map((p) =>
          p && typeof p === "object"
            ? { speaker: str(p.speaker), text: str(p.text) }
            : { speaker: "", text: str(p) }
        )
        .filter((p) => p.text),
    }))
    .filter((sec) => sec.paragraphs.length);
}

/** Strip accidental ```json fences if the model adds them. */
function extractJson(raw) {
  let s = (raw || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) s = s.slice(first, last + 1);
  return s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Errors worth retrying / failing over to another model: overload (503),
// transient 500s, and rate limits (429).
function isTransient(msg, code) {
  return (
    code === 503 ||
    code === 500 ||
    code === 429 ||
    /unavailable|high demand|overload|try again|internal|quota|rate|429|503|500/i.test(msg)
  );
}

// Try the primary model, then the fallback, each with a couple of retries.
async function generateJson(ai, contents, extraConfig = {}) {
  const models = MODEL === FALLBACK_MODEL ? [MODEL] : [MODEL, FALLBACK_MODEL];
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config: {
            ...extraConfig,
            temperature: 0.4,
            responseMimeType: "application/json",
            maxOutputTokens: 65536, // full transcriptions can be long
            // Skip the model's hidden "thinking" pass — transcription/formatting
            // doesn't need it and it adds a lot of latency.
            // (Only Flash models allow turning it off completely.)
            ...(/flash/i.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          },
        });
        const text = response.text;
        if (text && text.trim()) return text;
        lastErr = new Error("empty response from " + model);
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || err);
        const code = err?.code || err?.status;
        // Hard auth errors: stop immediately, don't burn retries.
        if (/api key|api_key|permission|unauthenticated|401|403/i.test(msg)) throw err;
        if (!isTransient(msg, code)) break; // non-transient → try next model
      }
      await sleep(900 * (attempt + 1)); // backoff before next attempt
    }
  }
  throw lastErr;
}

export async function analyzeContent(context) {
  const ai = getClient();

  let raw;
  try {
    if (context.sourceUsed === "video" && context.videoUrl) {
      // No captions: let Gemini watch the YouTube video itself. Low media
      // resolution keeps it fast and cheap — only the audio really matters.
      try {
        raw = await generateJson(
          ai,
          [
            {
              role: "user",
              parts: [{ fileData: { fileUri: context.videoUrl } }, { text: buildPrompt(context) }],
            },
          ],
          { mediaResolution: "MEDIA_RESOLUTION_LOW" }
        );
      } catch (err) {
        console.warn("Gemini couldn't watch the video, using title/description instead:", err?.message || err);
        if (!context.text.trim()) {
          throw new AppError(
            422,
            "This YouTube video couldn't be read — it may be private, age-restricted, removed, or too long. Try a different video."
          );
        }
        context = { ...context, sourceUsed: "metadata" };
      }
    }
    if (!raw) raw = await generateJson(ai, buildPrompt(context));
  } catch (err) {
    if (err instanceof AppError) throw err;
    const msg = String(err?.message || err);
    const code = err?.code || err?.status;
    if (/api key|api_key|permission|unauthenticated|401|403/i.test(msg)) {
      throw new AppError(
        502,
        "Gemini rejected the request — your GEMINI_API_KEY may be invalid or lacks access. Double-check the key in your .env file."
      );
    }
    if (code === 429 || /quota|rate/i.test(msg)) {
      throw new AppError(
        502,
        "Gemini is rate-limited or out of quota right now. Wait a moment and try again."
      );
    }
    if (code === 503 || /unavailable|high demand|overload/i.test(msg)) {
      throw new AppError(
        503,
        "Gemini is busy right now (high demand). Give it a few seconds and send the link again."
      );
    }
    throw new AppError(502, "The AI analysis failed. Please try again in a moment.");
  }

  let parsed;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    throw new AppError(
      502,
      "The AI returned an unexpected response. Please try again."
    );
  }

  const subtitle = str(parsed.subtitle) || "No summary could be generated for this video.";
  return {
    category: coerceCategory(parsed.category),
    sourceUsed: context.sourceUsed, // "transcript" | "video" | "metadata"
    title: str(parsed.title) || context.title || "Video Notes",
    subtitle,
    overview: subtitle, // kept for the web UI / publish check
    transcript: toTranscript(parsed.transcript),
    keyTakeaways: toPairs(parsed.keyTakeaways, "concept", "detail"),
    actionableSteps: toPairs(parsed.actionableSteps, "action", "detail"),
  };
}
