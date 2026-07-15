/**
 * 跑在 MAIN world（頁面的 JS 環境）。
 * 職責只有兩件事：
 *   1. 監聽 YouTube 自己發出的 /api/timedtext 請求，攔下字幕內容
 *   2. 應 content.js 要求，讀出 player 的字幕軌清單並主動抓取
 * 用 window.postMessage 跟 content.js（isolated world）溝通。
 */
(() => {
  "use strict";

  const origFetch = window.fetch;
  const post = (type, payload) =>
    window.postMessage({ __ytab: true, dir: "page", type, payload }, location.origin);

  const vid = () => new URLSearchParams(location.search).get("v");
  const isTimedText = (url) => typeof url === "string" && url.includes("/api/timedtext");

  // ---- 1. 攔截 YouTube 自己抓的字幕（使用者按下 CC 時會觸發）----
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (isTimedText(url)) {
        res
          .clone()
          .text()
          .then((text) => text && post("captions", { videoId: vid(), text, source: "sniff" }))
          .catch(() => {});
      }
    } catch (_) {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ytabUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (isTimedText(this.__ytabUrl)) {
      this.addEventListener("load", () => {
        if (this.responseText)
          post("captions", { videoId: vid(), text: this.responseText, source: "sniff" });
      });
    }
    return origSend.apply(this, args);
  };

  // ---- 2. 主動讀取字幕軌 ----
  const playerResponse = () => {
    const p = document.getElementById("movie_player");
    if (p && typeof p.getPlayerResponse === "function") {
      try {
        return p.getPlayerResponse();
      } catch (_) {}
    }
    return window.ytInitialPlayerResponse || null;
  };

  const listTracks = () => {
    const raw =
      playerResponse()?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    return raw.map((t, i) => ({
      i,
      baseUrl: t.baseUrl,
      lang: t.languageCode || "",
      kind: t.kind || "", // "asr" = 自動生成
      name:
        t.name?.simpleText ||
        t.name?.runs?.map((r) => r.text).join("") ||
        t.languageCode ||
        `track ${i}`,
    }));
  };

  window.addEventListener("message", async (e) => {
    const m = e.data;
    if (e.source !== window || !m || !m.__ytab || m.dir !== "content") return;

    if (m.type === "list-tracks") {
      post("tracks", { videoId: vid(), tracks: listTracks().map(({ baseUrl, ...t }) => t) });
      return;
    }

    if (m.type === "fetch-track") {
      const t = listTracks().find((x) => x.i === m.payload.i);
      if (!t) return post("captions", { videoId: vid(), text: "", error: "找不到字幕軌" });
      try {
        const url = t.baseUrl.includes("fmt=") ? t.baseUrl : t.baseUrl + "&fmt=json3";
        const r = await origFetch(url, { credentials: "include" });
        const text = await r.text();
        post("captions", { videoId: vid(), text, kind: t.kind, source: "fetch" });
      } catch (err) {
        post("captions", { videoId: vid(), text: "", error: String(err) });
      }
    }
  });
})();
