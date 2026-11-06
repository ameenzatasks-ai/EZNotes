// lib/context.js
// Fetches a video's transcript (preferred) or page context (fallback)
// for YouTube and Facebook links. Throws AppError with a friendly,
// user-facing message when a video is private/unreadable.

import { YoutubeTranscript } from "youtube-transcript";

// A small helper so routes can turn errors into clean HTTP responses.
export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = "AppError";
  }
}

const MAX_CHARS = 30000; // keep prompts fast + within model limits
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Detects the platform from a URL.
 * @returns {"youtube" | "facebook" | null}
 */
export function detectPlatform(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
  if (
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "youtu.be" ||
    host.endsWith(".youtube.com")
  ) {
    return "youtube";
  }
  if (
    host === "facebook.com" ||
    host === "m.facebook.com" ||
    host === "fb.watch" ||
    host === "fb.com" ||
    host.endsWith(".facebook.com")
  ) {
    return "facebook";
  }
  return null;
}

/** Extracts the 11-char YouTube video id from any common YouTube URL shape. */
function extractYouTubeId(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.hostname.replace(/^www\./, "") === "youtu.be") {
      return u.pathname.slice(1).split("/")[0] || null;
    }
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    // /shorts/<id>, /embed/<id>, /live/<id>
    const m = u.pathname.match(/\/(shorts|embed|live|v)\/([^/?#]+)/);
    if (m) return m[2];
    return null;
  } catch {
    return null;
  }
}

/** Fetch raw HTML with a browser-like UA and a hard timeout. */
async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Pull OpenGraph / meta context (title + description) from an HTML page. */
function parseMeta(html) {
  if (!html) return { title: "", description: "" };
  const grab = (re) => {
    const m = html.match(re);
    return m ? decodeEntities(m[1].trim()) : "";
  };
  const title =
    grab(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    grab(/<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)["']/i) ||
    grab(/<title[^>]*>([^<]+)<\/title>/i);
  const description =
    grab(
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i
    ) ||
    grab(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return { title, description };
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");
}

function clamp(text) {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS) + "\n\n[Transcript truncated for length…]";
}

// ---- YouTube ---------------------------------------------------------------

async function getYouTubeContext(rawUrl) {
  const id = extractYouTubeId(rawUrl);
  if (!id) {
    throw new AppError(
      400,
      "That doesn't look like a complete YouTube video link. Copy the URL straight from the address bar and try again."
    );
  }

  // 1) Best case: real captions / transcript.
  const fetchTranscript = async () => {
    const join = (parts) => parts.map((p) => p.text).join(" ").replace(/\s+/g, " ").trim();
    try {
      return join(await YoutubeTranscript.fetchTranscript(id, { lang: "en" }));
    } catch {
      // Try again without forcing a language (auto / original captions).
      try {
        return join(await YoutubeTranscript.fetchTranscript(id));
      } catch {
        return "";
      }
    }
  };

  // Grab title/author for display + as fallback context.
  const fetchOembed = async () => {
    try {
      const oembed = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(
          `https://www.youtube.com/watch?v=${id}`
        )}&format=json`,
        { headers: { "User-Agent": BROWSER_UA } }
      );
      if (oembed.ok) return await oembed.json();
    } catch {
      /* ignore */
    }
    return {};
  };

  // Run both lookups at the same time instead of one after the other.
  const [transcript, oembedData] = await Promise.all([fetchTranscript(), fetchOembed()]);
  let title = oembedData.title || "";
  const description = oembedData.author_name ? `By ${oembedData.author_name}. ` : "";

  const videoUrl = `https://www.youtube.com/watch?v=${id}`;

  if (transcript && transcript.length > 40) {
    return {
      platform: "youtube",
      title: title || "YouTube video",
      sourceUsed: "transcript",
      text: clamp(transcript),
      videoUrl,
    };
  }

  // 2) No captions we could fetch (common on cloud servers, which YouTube
  // often blocks). Hand the video link to Gemini, which can watch public
  // YouTube videos itself. Page metadata is passed along as extra context and
  // as a last-resort fallback.
  const meta = parseMeta(await fetchHtml(videoUrl));
  title = title || meta.title;
  const context = [title, meta.description, description].filter(Boolean).join("\n");

  return {
    platform: "youtube",
    title: title || "YouTube video",
    sourceUsed: "video",
    text: clamp(context),
    videoUrl,
  };
}

// ---- Facebook --------------------------------------------------------------

async function getFacebookContext(rawUrl) {
  // Facebook rarely exposes transcripts to anonymous requests, so we rely on
  // OpenGraph metadata (title + description) as the readable "context".
  const html = await fetchHtml(rawUrl);
  const meta = parseMeta(html);
  const looksBlocked =
    !html ||
    /you must log in/i.test(html) ||
    /log into facebook/i.test(meta.title);

  const context = [meta.title, meta.description].filter(Boolean).join("\n");

  if (looksBlocked || !context.trim() || context.trim().length < 25) {
    throw new AppError(
      422,
      "This Facebook video couldn't be read. It's likely private, login-restricted, or unavailable to the public. Make sure the post is public and try again."
    );
  }

  return {
    platform: "facebook",
    title: meta.title || "Facebook video",
    sourceUsed: "metadata",
    text: clamp(context),
  };
}

/**
 * Main entry: resolve a link into { platform, title, sourceUsed, text }.
 * Throws AppError(400|422) on bad/unreadable links.
 */
export async function getVideoContext(rawUrl) {
  const url = (rawUrl || "").trim();
  if (!url) throw new AppError(400, "Please paste a video link first.");

  const platform = detectPlatform(url);
  if (!platform) {
    throw new AppError(
      400,
      "Only YouTube and Facebook links are supported right now. Paste a link from one of those."
    );
  }

  if (platform === "youtube") return getYouTubeContext(url);
  return getFacebookContext(url);
}
