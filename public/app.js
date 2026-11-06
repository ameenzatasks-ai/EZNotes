// public/app.js — 2ndBrain AI frontend
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const form = $("analyze-form");
  const urlInput = $("video-url");
  const analyzeBtn = $("analyze-btn");

  const loading = $("loading");
  const loadingText = $("loading-text");
  const errorBox = $("error");
  const errorText = $("error-text");
  const errorRetry = $("error-retry");

  const result = $("result");
  const resultSource = $("result-source");
  const resultTitle = $("result-title");
  const resultCategory = $("result-category");
  const resultOverview = $("result-overview");
  const takeawaysBlock = $("takeaways-block");
  const takeawaysList = $("result-takeaways");
  const actionsBlock = $("actions-block");
  const actionsList = $("result-actions");
  const publishBtn = $("publish-btn");
  const resetBtn = $("reset-btn");
  const publishStatus = $("publish-status");

  // Holds the latest analysis so the Word export sends the exact same content.
  let current = null;
  const loadingMessages = [
    "🔍 Fetching transcript…",
    "📖 Reading the content…",
    "🤖 AI is analyzing…",
    "✨ Generating summary…",
  ];
  let loadingTimer = null;

  function show(el) {
    el.hidden = false;
  }
  function hide(el) {
    el.hidden = true;
  }

  function setLoading(on) {
    if (on) {
      hide(errorBox);
      hide(result);
      show(loading);
      analyzeBtn.disabled = true;
      analyzeBtn.textContent = "Analyzing…";
      let i = 0;
      loadingText.textContent = loadingMessages[0];
      loadingTimer = setInterval(() => {
        i = (i + 1) % loadingMessages.length;
        loadingText.textContent = loadingMessages[i];
      }, 1800);
    } else {
      hide(loading);
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = "Analyze video";
      clearInterval(loadingTimer);
    }
  }

  function showError(message) {
    errorText.textContent =
      message || "Something went wrong. Please try again.";
    show(errorBox);
    hide(result);
  }

  function renderList(ul, items) {
    ul.innerHTML = "";
    (items || []).forEach((item) => {
      const li = document.createElement("li");
      if (item && typeof item === "object") {
        // {concept, detail} or {action, detail}
        const head = item.concept || item.action || "";
        if (head) {
          const b = document.createElement("strong");
          b.textContent = head + (item.detail ? (item.concept ? ": " : " — ") : "");
          li.appendChild(b);
        }
        li.appendChild(document.createTextNode(item.detail || ""));
      } else {
        li.textContent = item;
      }
      ul.appendChild(li);
    });
  }

  function renderResult(data) {
    current = data;

    resultSource.textContent =
      data.sourceUsed === "metadata"
        ? "From title & description (no captions found)"
        : data.sourceUsed === "video"
        ? "Transcribed from the video"
        : "From transcript";
    resultTitle.textContent = data.title || data.videoTitle || "Video summary";
    resultCategory.textContent = data.category;
    resultOverview.textContent = data.overview;

    if (data.keyTakeaways && data.keyTakeaways.length) {
      show(takeawaysBlock);
      renderList(takeawaysList, data.keyTakeaways);
    } else {
      hide(takeawaysBlock);
    }

    if (data.actionableSteps && data.actionableSteps.length) {
      show(actionsBlock);
      renderList(actionsList, data.actionableSteps);
    } else {
      hide(actionsBlock);
    }

    hide(publishStatus);
    publishStatus.innerHTML = "";
    show(result);
    result.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function analyze(url) {
    setLoading(true);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      setLoading(false);

      if (!res.ok || !data.ok) {
        showError(data.error || `Request failed (${res.status}).`);
        return;
      }
      renderResult(data);
    } catch (err) {
      setLoading(false);
      showError(
        "Couldn't reach the server. Make sure the app is running and try again."
      );
    }
  }

  async function publish() {
    if (!current) return;
    const original = publishBtn.innerHTML;
    publishBtn.disabled = true;
    publishBtn.textContent = "Saving & sending…";
    hide(publishStatus);
    publishStatus.innerHTML = "";

    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(current),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.ok) {
        showError(data.error || `Publish failed (${res.status}).`);
        return;
      }

      const docLink = data.docUrl
        ? `<a class="publish-link" href="${data.docUrl}" target="_blank" rel="noopener">Open Google Doc ↗</a>`
        : "";
      const tg = data.telegram
        ? `<span class="publish-ok">✓ Sent to Telegram</span>`
        : `<span class="publish-warn">⚠ ${
            data.telegramError || "Telegram send failed"
          }</span>`;

      publishStatus.innerHTML = `<span class="publish-ok">✓ Saved to Google Docs</span> ${docLink} ${tg}`;
      show(publishStatus);
    } catch (err) {
      showError(
        "Couldn't reach the server while publishing. Make sure the app is running and try again."
      );
    } finally {
      publishBtn.disabled = false;
      publishBtn.innerHTML = original;
    }
  }

  // --- Events ---
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) {
      showError("Please paste a video link first.");
      urlInput.focus();
      return;
    }
    analyze(url);
  });

  errorRetry.addEventListener("click", () => {
    hide(errorBox);
    urlInput.focus();
  });

  resetBtn.addEventListener("click", () => {
    hide(result);
    current = null;
    urlInput.value = "";
    urlInput.focus();
    document.getElementById("app").scrollIntoView({ behavior: "smooth" });
  });

  publishBtn.addEventListener("click", publish);
})();
