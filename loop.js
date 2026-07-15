(() => {
  "use strict";

  const PANEL_ID = "ytab-panel";
  const NUDGE = 0.5;   // 手動微調秒數
  const LEAD = 0.2;    // 每句往前多留，避免字頭被切掉
  const TAIL = 0.3;    // 每句往後多留，避免尾音被切掉

  // 切句參數（ASR 沒有標點，靠停頓切「氣口」）
  const GAP = 0.65;    // 停頓超過這個秒數 → 斷句
  const MAX = 12;      // 單句最長秒數
  const MIN = 1.2;     // 太短的句子併進下一句

  let video = null;
  let panel = null;
  let videoId = null;
  let enabled = false;   // ← 預設關閉，按工具列圖示 / Alt+L 才開
  let waiting = false;

  let state = { a: null, b: null, looping: false, delay: 0 };
  let sentences = [];
  let curIdx = -1;
  let tracks = [];
  let pickedTrack = null;

  // ---------- utils ----------
  const fmt = (t) => {
    if (t === null || t === undefined || Number.isNaN(t)) return "--:--.-";
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(1).padStart(4, "0");
    return `${String(m).padStart(2, "0")}:${s}`;
  };
  const currentVideoId = () => new URLSearchParams(location.search).get("v");
  const clamp = (t) => Math.max(0, Math.min(t, video?.duration || t));
  const toPage = (type, payload) =>
    window.postMessage({ __ytab: true, dir: "content", type, payload }, location.origin);

  // ---------- 儲存 ----------
  // 重新載入擴充功能後，舊分頁的 content script 會變孤兒：
  // chrome.* 一呼叫就丟 "Extension context invalidated"。偵測到就整個停機。
  let ctxDead = false;
  const alive = () => {
    if (ctxDead) return false;
    try {
      if (chrome.runtime?.id) return true;
    } catch (_) {}
    ctxDead = true;
    document.getElementById(PANEL_ID)?.remove();
    return false;
  };

  const get = (key) =>
    new Promise((r) => {
      if (!alive()) return r(undefined);
      try {
        chrome.storage.local.get(key, (v) => r(v?.[key]));
      } catch (_) {
        r(undefined);
      }
    });
  const set = (key, value) => {
    if (!alive()) return;
    try {
      chrome.storage.local.set({ [key]: value });
    } catch (_) {}
  };

  const saveAB = () => {
    if (!videoId) return;
    set(`ab:${videoId}`, { a: state.a, b: state.b, delay: state.delay });
  };

  const reportState = () => {
    try { chrome.runtime.sendMessage({ type: "ytab-state", on: enabled }); } catch (_) {}
  };

  // 完成一輪循環 → 記進 Language Quest（background 會排隊送 Supabase）。
  // 暫停中拖進度條也會觸發繞回，那不算練習，靠 !video.paused 擋掉。
  const reportRep = () => {
    if (video.paused) return;
    try {
      chrome.runtime.sendMessage({
        type: "loop-done",
        videoId,
        durationSec: state.b - state.a,
      });
    } catch (_) {}
    if (questOn) showXpToast("+5 🍪");
  };

  // ---------- Language Quest 回饋 ----------
  // 有登入才顯示 XP toast，不然數字是假的
  let questOn = false;
  chrome.storage.local.get("sbSession", (v) => (questOn = !!v.sbSession));
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.sbSession) questOn = !!ch.sbSession.newValue;
  });

  function showXpToast(text) {
    if (!panel) return; // 掛在面板內；面板沒開就不顯示
    const el = document.createElement("div");
    el.className = "ytab-xp-toast";
    el.textContent = text;
    el.style.right = `${16 + Math.random() * 24}px`; // 連續好幾輪時稍微錯開
    panel.appendChild(el);
    setTimeout(() => el.remove(), 1400);
  }

  // 升級 / 成就解鎖：全螢幕 confetti + 卡片（background flush 後推過來）
  function showCelebration({ level, achievements }) {
    document.querySelector(".ytab-celebrate")?.remove();
    const ov = document.createElement("div");
    ov.className = "ytab-celebrate";

    for (let i = 0; i < 48; i++) {
      const c = document.createElement("span");
      c.className = "ytab-confetti";
      c.style.left = `${Math.random() * 100}%`;
      c.style.background = ["#17b877", "#f6a01a", "#3ea6ff", "#f472b6", "#facc15"][i % 5];
      c.style.animationDelay = `${Math.random() * 0.6}s`;
      c.style.animationDuration = `${1.6 + Math.random() * 1.2}s`;
      ov.appendChild(c);
    }

    const card = document.createElement("div");
    card.className = "ytab-celebrate-card";
    if (level) {
      const lv = document.createElement("div");
      lv.className = "ytab-celebrate-lv";
      lv.textContent = `LV ${level}`;
      const t = document.createElement("div");
      t.className = "ytab-celebrate-title";
      t.textContent = "升級了！🦜";
      card.append(lv, t);
    }
    for (const a of achievements || []) {
      const row = document.createElement("div");
      row.className = "ytab-celebrate-ach";
      row.textContent = `🏅 ${a}`;
      card.appendChild(row);
    }
    ov.appendChild(card);

    ov.addEventListener("click", () => ov.remove());
    document.body.appendChild(ov);
    setTimeout(() => ov.remove(), 4200);
  }

  // ---------- 字幕解析 ----------
  function parseCaptions(text) {
    const raw = text.trim();
    if (!raw) return [];

    if (raw.startsWith("{")) { // json3
      let data;
      try { data = JSON.parse(raw); } catch { return []; }
      const cues = [];
      for (const ev of data.events || []) {
        if (!ev.segs || ev.aAppend) continue; // aAppend = 自動字幕的滾動重複行
        const t = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
        if (!t || /^\[.*\]$/.test(t)) continue;
        cues.push({
          start: (ev.tStartMs || 0) / 1000,
          end: ((ev.tStartMs || 0) + (ev.dDurationMs || 0)) / 1000,
          text: t,
        });
      }
      return cues;
    }

    // XML (srv1 / srv3)
    const doc = new DOMParser().parseFromString(raw, "text/xml");
    const cues = [];
    doc.querySelectorAll("text").forEach((n) => {
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (!t) return;
      const start = parseFloat(n.getAttribute("start") || "0");
      cues.push({ start, end: start + parseFloat(n.getAttribute("dur") || "0"), text: t });
    });
    doc.querySelectorAll("p").forEach((n) => {
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (!t) return;
      const start = parseInt(n.getAttribute("t") || "0", 10) / 1000;
      cues.push({ start, end: start + parseInt(n.getAttribute("d") || "0", 10) / 1000, text: t });
    });
    return cues.sort((x, y) => x.start - y.start);
  }

  const decode = (s) => {
    const el = document.createElement("textarea");
    el.innerHTML = s;
    return el.value;
  };

  function buildSentences(cues, isAsr) {
    const out = [];
    let cur = null;
    let prev = null;

    for (const c of cues) {
      const text = decode(c.text);
      if (prev && text === prev) continue;
      prev = text;

      if (!cur) { cur = { start: c.start, end: c.end, text }; continue; }

      const gap = c.start - cur.end;
      const tooLong = c.end - cur.start > MAX;
      const ended = !isAsr && /[.!?。！？…"']$/.test(cur.text);

      if (ended || gap > GAP || tooLong) {
        out.push(cur);
        cur = { start: c.start, end: c.end, text };
      } else {
        cur.text += " " + text;
        cur.end = c.end;
      }
    }
    if (cur) out.push(cur);

    const merged = [];
    for (const s of out) {
      const last = merged[merged.length - 1];
      if (last && last.end - last.start < MIN && s.start - last.end < GAP) {
        last.text += " " + s.text;
        last.end = s.end;
      } else merged.push(s);
    }
    return merged.map((s) => ({ ...s, text: s.text.replace(/\s+/g, " ").trim() }));
  }

  // ---------- 循環引擎 ----------
  function tick() {
    if (ctxDead) return; // 孤兒 script：停掉 rAF 鏈
    requestAnimationFrame(tick);
    if (!enabled || !video || !panel) return;

    if (state.looping && !waiting && state.a !== null && state.b !== null && state.b > state.a) {
      if (video.currentTime >= state.b) {
        reportRep();
        if (state.delay > 0) {
          waiting = true;
          video.pause();
          setTimeout(() => {
            waiting = false;
            if (!enabled || !state.looping || !video) return;
            video.currentTime = state.a;
            video.play();
          }, state.delay * 1000);
        } else {
          video.currentTime = state.a;
        }
      }
    }
    updateProgress();
    syncActiveSentence();
  }

  // ---------- 句子 ----------
  function playSentence(i) {
    const s = sentences[i];
    if (!s || !video) return;
    curIdx = i;
    state.a = clamp(s.start - LEAD);
    state.b = clamp(s.end + TAIL);
    state.looping = true;
    video.currentTime = state.a;
    video.play();
    saveAB();
    render();
    panel?.querySelector(".ytab-item.is-on")?.scrollIntoView({ block: "nearest" });
  }

  const step = (d) => {
    if (!sentences.length) return;
    const base = curIdx >= 0 ? curIdx : nearestSentence();
    playSentence(Math.max(0, Math.min(sentences.length - 1, base + d)));
  };

  function nearestSentence() {
    if (!video) return 0;
    const t = video.currentTime;
    for (let i = 0; i < sentences.length; i++) if (sentences[i].end >= t) return i;
    return sentences.length - 1;
  }

  function syncActiveSentence() {
    if (!sentences.length || state.looping) return;
    const i = nearestSentence();
    if (i !== curIdx) { curIdx = i; highlight(); }
  }

  const highlight = () =>
    panel?.querySelectorAll(".ytab-item").forEach((el, i) => el.classList.toggle("is-on", i === curIdx));

  // ---------- 面板 ----------
  const html = `
    <div class="ytab-head">
      <span class="ytab-brand">AB LOOP</span>
      <div class="ytab-bar"><div class="ytab-range"></div><div class="ytab-dot"></div></div>
      <button class="ytab-close" data-act="off" title="關閉面板（Alt+L）">×</button>
    </div>

    <div class="ytab-row">
      <button class="ytab-btn ytab-mark" data-act="setA">設 A</button>
      <span class="ytab-time" data-t="a">--:--.-</span>
      <button class="ytab-nudge" data-act="a-">−</button>
      <button class="ytab-nudge" data-act="a+">＋</button>
      <span class="ytab-sep"></span>
      <button class="ytab-btn ytab-mark" data-act="setB">設 B</button>
      <span class="ytab-time" data-t="b">--:--.-</span>
      <button class="ytab-nudge" data-act="b-">−</button>
      <button class="ytab-nudge" data-act="b+">＋</button>
      <span class="ytab-sep"></span>
      <button class="ytab-btn ytab-loop" data-act="toggle">開始循環</button>
      <button class="ytab-btn ytab-ghost" data-act="clear">清除</button>
    </div>

    <div class="ytab-row ytab-row2">
      <span class="ytab-label">速度</span>
      <button class="ytab-chip" data-rate="0.5">0.5×</button>
      <button class="ytab-chip" data-rate="0.75">0.75×</button>
      <button class="ytab-chip" data-rate="1">1×</button>
      <span class="ytab-sep"></span>
      <span class="ytab-label">每輪間隔</span>
      <input class="ytab-input" data-act="delay" type="number" min="0" max="30" step="0.5" value="0">
      <span class="ytab-label">秒</span>
      <span class="ytab-hint">[ 設A ・ ] 設B ・ \\ 循環 ・ , 上一句 ・ . 下一句</span>
    </div>

    <div class="ytab-cap">
      <div class="ytab-row">
        <span class="ytab-label">字幕切句</span>
        <select class="ytab-select" data-act="track"></select>
        <button class="ytab-btn" data-act="load">載入</button>
        <button class="ytab-btn" data-act="prev">← 上一句</button>
        <button class="ytab-btn" data-act="next">下一句 →</button>
        <label class="ytab-check"><input type="checkbox" data-act="hide"> 先聽再看</label>
        <span class="ytab-status"></span>
      </div>
      <ol class="ytab-list"></ol>
    </div>
  `;

  function mountPanel() {
    document.getElementById(PANEL_ID)?.remove();
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = html;

    const host = document.querySelector("#above-the-fold");
    if (host) host.prepend(panel);
    else {
      panel.classList.add("ytab-float");
      document.body.appendChild(panel);
    }
    panel.addEventListener("click", onClick);
    panel.addEventListener("change", onChange);
  }

  // ---------- 開 / 關 ----------
  async function enable() {
    if (enabled || !videoId || !video) return;
    enabled = true;
    set(`on:${videoId}`, true); // 記住這支影片開過，下次自動展開

    const saved = await get(`ab:${videoId}`);
    if (saved) {
      state.a = saved.a ?? null;
      state.b = saved.b ?? null;
      state.delay = saved.delay ?? 0;
    }

    mountPanel();
    render();
    status("讀取字幕軌…");
    setTimeout(() => toPage("list-tracks"), 300);
    reportState();
  }

  function disable() {
    enabled = false;
    state.looping = false;
    waiting = false;
    if (videoId) set(`on:${videoId}`, false);
    document.getElementById(PANEL_ID)?.remove();
    panel = null;
    reportState();
  }

  const toggleEnabled = () => (enabled ? disable() : enable());

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "ytab-toggle") {
      if (currentVideoId()) toggleEnabled();
      sendResponse({ on: enabled });
    }
    if (msg?.type === "quest-celebrate") {
      showCelebration(msg); // 面板沒開也照放——升級是升級
      sendResponse({ shown: true });
    }
  });

  // ---------- 事件 ----------
  let pendingPlay = null;

  function onClick(e) {
    const item = e.target.closest(".ytab-item");
    if (item) {
      // 雙擊／拖曳是在選字查詢，不能跳句打斷正在循環的區段：
      // 延遲一拍再跳，期間出現第二擊或文字選取就取消。
      clearTimeout(pendingPlay);
      if (e.detail > 1) return; // 雙擊的第二下 → 交給選字查詢
      const i = Number(item.dataset.i);
      pendingPlay = setTimeout(() => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return; // 有選取 → 使用者在選字
        playSentence(i);
      }, 300);
      return;
    }

    const btn = e.target.closest("button");
    if (!btn || !video) return;

    if (btn.dataset.rate) {
      video.playbackRate = parseFloat(btn.dataset.rate);
      return render();
    }

    switch (btn.dataset.act) {
      case "off": return disable();
      case "setA":
        state.a = video.currentTime;
        if (state.b !== null && state.b <= state.a) state.b = null;
        break;
      case "setB":
        state.b = video.currentTime;
        if (state.a !== null && state.b <= state.a) state.a = null;
        break;
      case "a-": if (state.a !== null) state.a = clamp(state.a - NUDGE); break;
      case "a+": if (state.a !== null) state.a = clamp(state.a + NUDGE); break;
      case "b-": if (state.b !== null) state.b = clamp(state.b - NUDGE); break;
      case "b+": if (state.b !== null) state.b = clamp(state.b + NUDGE); break;
      case "toggle": toggleLoop(); break;
      case "clear": state.a = null; state.b = null; state.looping = false; curIdx = -1; break;
      case "load": return requestCaptions();
      case "prev": return step(-1);
      case "next": return step(1);
    }
    saveAB();
    render();
  }

  function onChange(e) {
    const el = e.target;
    if (el.dataset.act === "delay") {
      state.delay = Math.max(0, parseFloat(el.value) || 0);
      saveAB();
    }
    if (el.dataset.act === "hide") {
      panel.querySelector(".ytab-list").classList.toggle("is-hidden", el.checked);
    }
    if (el.dataset.act === "track") {
      pickedTrack = Number(el.value);
      requestCaptions();
    }
  }

  function toggleLoop() {
    if (state.a === null || state.b === null || state.b <= state.a) return (state.looping = false);
    state.looping = !state.looping;
    if (state.looping) {
      video.currentTime = state.a;
      video.play();
    }
  }

  function updateProgress() {
    const bar = panel.querySelector(".ytab-range");
    const dot = panel.querySelector(".ytab-dot");
    if (!bar || !video?.duration) return;
    if (state.a !== null && state.b !== null) {
      bar.style.left = `${(state.a / video.duration) * 100}%`;
      bar.style.width = `${((state.b - state.a) / video.duration) * 100}%`;
      bar.style.opacity = "1";
    } else bar.style.opacity = "0";
    dot.style.left = `${(video.currentTime / video.duration) * 100}%`;
  }

  const status = (msg) => {
    const el = panel?.querySelector(".ytab-status");
    if (el) el.textContent = msg;
  };

  function render() {
    if (!panel) return;
    panel.querySelector('[data-t="a"]').textContent = fmt(state.a);
    panel.querySelector('[data-t="b"]').textContent = fmt(state.b);

    const btn = panel.querySelector(".ytab-loop");
    const ready = state.a !== null && state.b !== null && state.b > state.a;
    btn.textContent = state.looping ? "循環中，點此停止" : "開始循環";
    btn.classList.toggle("is-on", state.looping);
    btn.disabled = !ready;

    panel.querySelector('[data-act="delay"]').value = state.delay;
    panel.querySelectorAll(".ytab-chip").forEach((c) =>
      c.classList.toggle("is-on", parseFloat(c.dataset.rate) === (video?.playbackRate ?? 1))
    );
    highlight();
    updateProgress();
  }

  function renderList() {
    panel.querySelector(".ytab-list").innerHTML = sentences
      .map(
        (s, i) => `<li class="ytab-item" data-i="${i}">
          <span class="ytab-idx">${String(i + 1).padStart(3, "0")}</span>
          <span class="ytab-t">${fmt(s.start)}</span>
          <span class="ytab-text">${s.text.replace(/</g, "&lt;")}</span>
        </li>`
      )
      .join("");
  }

  // ---------- 字幕流程 ----------
  function requestCaptions() {
    if (pickedTrack === null) return status("沒有可用的字幕軌");
    status("載入中…");
    toPage("fetch-track", { i: pickedTrack });
  }

  function fillTrackSelect() {
    const sel = panel.querySelector(".ytab-select");
    sel.innerHTML = tracks
      .map((t) => `<option value="${t.i}">${t.name}${t.kind === "asr" ? "（自動生成）" : ""}</option>`)
      .join("");
    if (pickedTrack !== null) sel.value = String(pickedTrack);
  }

  function pickBestTrack() {
    const en = tracks.filter((t) => t.lang.startsWith("en"));
    const best = en.find((t) => t.kind !== "asr") || en.find((t) => t.kind === "asr") || tracks[0];
    pickedTrack = best ? best.i : null;
    return best;
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (e.source !== window || !m || !m.__ytab || m.dir !== "page") return;
    if (!enabled || !panel) return;                       // 面板沒開就不處理
    if (m.payload?.videoId && m.payload.videoId !== videoId) return;

    if (m.type === "tracks") {
      tracks = m.payload.tracks || [];
      if (!tracks.length)
        return status("這支影片沒有字幕軌（畫面上的字是壓在影片裡的）。按一下播放器的 CC 試試，或改用手動 A/B。");
      const best = pickBestTrack();
      fillTrackSelect();
      status(`找到 ${tracks.length} 個字幕軌`);
      if (best) requestCaptions();
    }

    if (m.type === "captions") {
      if (m.payload.error || !m.payload.text)
        return status("抓不到字幕內容。開一次播放器的 CC，我會直接攔下來。");
      const track = tracks.find((t) => t.i === pickedTrack);
      const isAsr = m.payload.kind === "asr" || track?.kind === "asr";
      const cues = parseCaptions(m.payload.text);
      if (!cues.length) return status("字幕解析後是空的。");
      sentences = buildSentences(cues, isAsr);
      curIdx = -1;
      renderList();
      status(`切出 ${sentences.length} 句${isAsr ? "（自動字幕，依停頓斷句）" : ""}`);
    }
  });

  // ---------- 鍵盤 ----------
  function onKey(e) {
    if (!enabled || !video || !panel) return;            // 面板沒開，快捷鍵不作用
    const el = e.target;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === "[") { state.a = video.currentTime; if (state.b !== null && state.b <= state.a) state.b = null; }
    else if (e.key === "]") { state.b = video.currentTime; if (state.a !== null && state.b <= state.a) state.a = null; }
    else if (e.key === "\\") toggleLoop();
    else if (e.key === ",") step(-1);
    else if (e.key === ".") step(1);
    else return;

    e.preventDefault();
    e.stopPropagation();
    saveAB();
    render();
  }

  // ---------- 生命週期 ----------
  async function init() {
    const id = currentVideoId();

    if (!id) {                       // 不是播放頁
      if (enabled) disable();
      videoId = null;
      return;
    }

    const v = document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (!v) return;

    if (id === videoId) {            // 同一支影片：YouTube 重繪時把面板補回來
      if (enabled && (!panel || !document.contains(panel))) {
        mountPanel();
        render();
        renderList();
      }
      return;
    }

    // 換影片：重置
    document.getElementById(PANEL_ID)?.remove();
    panel = null;
    enabled = false;
    videoId = id;
    video = v;
    state = { a: null, b: null, looping: false, delay: 0 };
    sentences = []; tracks = []; curIdx = -1; pickedTrack = null;
    reportState();

    if (await get(`on:${id}`)) enable();   // 這支影片以前開過 → 自動展開
  }

  document.addEventListener("keydown", onKey, true);
  document.addEventListener("yt-navigate-finish", init);
  const initTimer = setInterval(() => {
    if (!alive()) return clearInterval(initTimer);
    init();
  }, 1000);
  init();
  requestAnimationFrame(tick);
})();
