/**
 * Parrot service worker，管三件事：
 *
 * 1. 工具列圖示 / Alt+L 的路由：
 *    YouTube 分頁 → 叫 loop.js 切換練習面板（該分頁的 popup 被設成空）；
 *    其他分頁 → 開 popup 看今日開口進度。
 * 2. 所有網路請求（查字典、Claude、備援翻譯、生詞本、learning_events）。
 *    content script 的 fetch 會被當成「頁面的 origin」而受 CORS 擋，
 *    service worker 有 host_permissions 就不受限。
 * 3. 每日開口（原 daily-english-gate）：每天第一次 focus Chrome 跳通知
 *    推你去 ChatGPT，追蹤分頁實際 active 時間，達標記 streak 並上報
 *    learning_events（chatgpt_voice）。
 */

const MODEL = "claude-haiku-4-5"; // 查單字用便宜快的就好

// Supabase（跟 vocab-app 同一個專案）。anon key 本來就是前端可公開的，
// 真正的權限在資料庫的 RLS policy —— 但整個資料夾仍不要上傳。
// 生詞本寫進 vocabularies（vocab-app 的 SRS 複習直接吃得到）；
// 循環完成寫進 learning_events（Language Quest 記分，需要登入）。
const SUPABASE_URL = "https://xrifxsnodrluzqokfpqq.supabase.co";
const SUPABASE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhyaWZ4c25vZHJsdXpxb2tmcHFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2MDE2MTIsImV4cCI6MjA5NTE3NzYxMn0.qxvStw8Tnjvm8uBtNFaKh6rZ5cTuRyRLRF8pbr5XcPY";

// ---- 圖示 / Alt+L ----
// manifest 的 default_popup 是 popup.html（開口進度）；
// YouTube 分頁把 popup 設成空字串，點圖示才會走 onClicked → 切換面板。
const YT_RE = /^https:\/\/(www\.)?youtube\.com\//;

function syncPopupForTab(tabId, url) {
  chrome.action.setPopup({ tabId, popup: YT_RE.test(url || "") ? "" : "popup.html" }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status || info.url) syncPopupForTab(tabId, tab.url);
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) syncPopupForTab(tabId, tab.url);
  gateActiveTabChanged(tabId);
});

chrome.action.onClicked.addListener(async (tab) => {
  // 只有 popup 被設成空的分頁（= YouTube）會走到這裡
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "ytab-toggle" });
  } catch (_) {
    // content script 尚未注入（剛安裝或剛重新載入擴充功能）→ 刷新分頁
    chrome.tabs.reload(tab.id);
  }
});

// ---- 訊息路由 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "lookup") {
    lookup(msg.text, msg.context).then(sendResponse);
    return true; // 非同步回覆
  }
  if (msg?.type === "save") {
    saveWord(msg.payload).then(sendResponse);
    return true;
  }
  if (msg?.type === "loop-done") {
    enqueueLoopEvent(msg).catch((e) => console.warn("[parrot] enqueue:", e));
    return; // fire-and-forget，不回覆
  }
  if (msg?.type === "gate-start") {
    gateBeginSession(true).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "quest-today") {
    questToday().then(sendResponse);
    return true;
  }
  if (msg?.type === "sb-login") {
    sbLogin(msg.email, msg.password).then(sendResponse);
    return true;
  }
  if (msg?.type === "sb-logout") {
    chrome.storage.local.remove("sbSession").then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "sb-status") {
    sbStatus().then(sendResponse);
    return true;
  }
  if (msg?.type === "vocab-list") {
    vocabList().then((c) => sendResponse(c.words));
    return true;
  }
  if (msg?.type === "ytab-state" && sender.tab?.id) {
    // loop.js 回報面板開關 → 在圖示上顯示 ON
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: msg.on ? "ON" : "" });
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#3ea6ff" });
  }
});

async function lookup(text, context) {
  const isWord = !/\s/.test(text) && text.length < 40;
  const { apiKey } = await chrome.storage.local.get("apiKey");

  const [dict, ai] = await Promise.all([
    isWord ? dictionary(text).catch(() => null) : null,
    apiKey ? claude(text, context, apiKey).catch((e) => ({ error: String(e) })) : null,
  ]);

  // 沒填 API key → 退回免費翻譯
  let fallbackZh = null;
  if (!apiKey || ai?.error) {
    fallbackZh = await gtx(text).catch(() => null);
  }

  return { text, isWord, dict, ai, fallbackZh, hasKey: !!apiKey };
}

// ---- Supabase 登入（learning_events 的 RLS 要 auth.uid()，anon key 過不了）----

async function sbLogin(email, password) {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: SUPABASE_KEY },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok)
      return { ok: false, error: data.error_description || data.msg || `HTTP ${r.status}` };
    await storeSession(data, email);
    flushEvents(); // 補送離線期間累積的事件
    return { ok: true, email: data.user?.email || email };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function storeSession(data, email) {
  await chrome.storage.local.set({
    sbSession: {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      // 提前 60 秒視為過期，避免拿到剛好失效的 token
      expires_at: Date.now() + Math.max(0, (data.expires_in || 3600) - 60) * 1000,
      email: data.user?.email || email,
    },
  });
}

let refreshing = null; // refresh token 會輪換，同時刷兩次舊的會失效

async function sbToken() {
  const { sbSession: s } = await chrome.storage.local.get("sbSession");
  if (!s) return null;
  if (Date.now() < s.expires_at) return s.access_token;

  refreshing ||= (async () => {
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: SUPABASE_KEY },
        body: JSON.stringify({ refresh_token: s.refresh_token }),
      });
      if (!r.ok) {
        await chrome.storage.local.remove("sbSession"); // token 已失效，要重新登入
        return null;
      }
      const data = await r.json();
      await storeSession(data, s.email);
      return data.access_token;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function sbStatus() {
  const { sbSession: s } = await chrome.storage.local.get("sbSession");
  const { evQueue = [] } = await chrome.storage.local.get("evQueue");
  return { loggedIn: !!s, email: s?.email || null, pending: evQueue.length };
}

// ---- 生詞本：寫進 vocab-app 的 vocabularies 表 ----
// 用「先查再 PATCH / POST」去重（unique index 是 lower(word) 的 expression
// index，PostgREST 的 on_conflict 吃不到）；只碰內容欄位，不動 SRS 排程欄位。
// migration 002 之後 RLS 只認 auth.uid()，必須登入。
async function saveWord(payload) {
  try {
    const token = await sbToken();
    if (!token) return { ok: false, needLogin: true, error: "not logged in" };
    const headers = {
      "content-type": "application/json",
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${token}`,
    };

    // 只送有值的欄位，避免免 API key 模式（只有翻譯）把舊資料洗成 null
    const row = {};
    for (const [k, v] of Object.entries({
      word: payload.word,
      ipa: payload.ipa,
      translation: payload.zh,
      example_sentence: payload.example,
      example_translation: payload.example_zh,
      source_url: payload.source_url,
    })) if (v != null && v !== "") row[k] = v;

    const found = await fetch(
      `${SUPABASE_URL}/rest/v1/vocabularies?word=eq.${encodeURIComponent(payload.word)}&select=id&limit=1`,
      { headers }
    ).then((r) => (r.ok ? r.json() : []));

    // example_sentence 是 NOT NULL：新增時保底空字串（更新時不送，才不會洗掉舊例句）
    if (!found[0]?.id) row.example_sentence ??= "";

    const r = found[0]?.id
      ? await fetch(`${SUPABASE_URL}/rest/v1/vocabularies?id=eq.${found[0].id}`, {
          method: "PATCH",
          headers: { ...headers, prefer: "return=minimal" },
          body: JSON.stringify(row),
        })
      : await fetch(`${SUPABASE_URL}/rest/v1/vocabularies`, {
          method: "POST",
          headers: { ...headers, prefer: "return=minimal" },
          body: JSON.stringify(row),
        });

    if (!r.ok) {
      const detail = (await r.text()).slice(0, 200);
      console.warn("[parrot] save failed:", r.status, detail);
      return { ok: false, error: `${r.status} ${detail}` };
    }

    // 新字直接補進快取（不等 TTL）→ storage.onChanged 讓開著的面板立刻高亮
    const { vocabCache } = await chrome.storage.local.get("vocabCache");
    if (vocabCache && !vocabCache.words[payload.word]) {
      vocabCache.words[payload.word] = "new";
      await chrome.storage.local.set({ vocabCache });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---- 生詞快取（loop.js 的字幕高亮用）----
// 讀 vocabularies 的 SRS 欄位，映成三種狀態：new（還沒背）、
// learn（複習中）、master（interval ≥ 21 天）。
// migration 002 之後 vocabularies 是帳號私有（RLS），要登入才讀得到。
const VOCAB_TTL = 10 * 60 * 1000;

const vocabStatus = (row) =>
  !row.repetitions ? "new" : (row.interval_days || 0) >= 21 ? "master" : "learn";

async function vocabList() {
  const { vocabCache } = await chrome.storage.local.get("vocabCache");
  if (vocabCache && Date.now() - vocabCache.at < VOCAB_TTL) return vocabCache;
  try {
    const token = await sbToken();
    if (!token) return vocabCache || { at: 0, words: {} }; // 沒登入：不高亮，也不覆寫舊快取
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vocabularies?select=word,repetitions,interval_days&limit=2000`,
      { headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${token}` } }
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const words = {};
    for (const row of await r.json())
      if (row.word) words[row.word.toLowerCase()] = vocabStatus(row);
    const cache = { at: Date.now(), words };
    await chrome.storage.local.set({ vocabCache: cache });
    return cache;
  } catch (e) {
    console.warn("[parrot] vocab list:", e);
    return vocabCache || { at: 0, words: {} };
  }
}

// ---- Language Quest：learning_events 上報 ----
// 先進 chrome.storage 的佇列再批次送，MV3 service worker 隨時會被殺；
// client_event_id 唯一 + ignore-duplicates，重送不會重複計分。

let flushTimer = null;
let flushing = false;

async function enqueueEvent(ev) {
  ev.occurred_at ??= new Date().toISOString();
  const { evQueue = [] } = await chrome.storage.local.get("evQueue");
  evQueue.push(ev);
  await chrome.storage.local.set({ evQueue: evQueue.slice(-500) });

  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushEvents, 5000); // 循環中會連續產生事件，攢 5 秒一起送
}

// 循環完成一輪 → ab_loop，每句 5 XP
async function enqueueLoopEvent({ videoId, durationSec }) {
  await enqueueEvent({
    source: "ab_loop",
    activity: "listening",
    duration_sec: Math.min(14400, Math.max(0, Math.round(durationSec || 0))),
    quantity: 1,
    client_event_id: `ab:${videoId || "manual"}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    meta: { video_id: videoId || null },
  });
}

async function flushEvents() {
  if (flushing) return;
  flushing = true;
  try {
    const token = await sbToken();
    if (!token) return; // 沒登入：事件留在佇列，登入後補送

    const { evQueue = [] } = await chrome.storage.local.get("evQueue");
    if (!evQueue.length) return;

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/learning_events?on_conflict=user_id,client_event_id`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          apikey: SUPABASE_KEY,
          authorization: `Bearer ${token}`,
          prefer: "resolution=ignore-duplicates,return=minimal",
        },
        body: JSON.stringify(evQueue),
      }
    );
    if (!r.ok) {
      console.warn("[parrot] flush failed:", r.status, (await r.text()).slice(0, 200));
      return; // 留在佇列，下次再試
    }

    // 只移除送出的那批；flush 期間新進的事件要留著
    const sent = new Set(evQueue.map((e) => e.client_event_id));
    const { evQueue: now = [] } = await chrome.storage.local.get("evQueue");
    await chrome.storage.local.set({ evQueue: now.filter((e) => !sent.has(e.client_event_id)) });

    await questAfterFlush(token); // 升級 / 成就偵測
  } catch (e) {
    console.warn("[parrot] flush:", e);
  } finally {
    flushing = false;
  }
}

// popup 的記分板：今日 XP + my_stats（LV / streak / 總時數）+ 生詞數。
// local_date 是 Asia/Taipei，不能用 toISOString（UTC）算日期。
async function questToday() {
  const token = await sbToken();
  if (!token) return { loggedIn: false };
  const headers = { apikey: SUPABASE_KEY, authorization: `Bearer ${token}` };
  try {
    const d = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
    const [todayRows, statsRows, vocabCount] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/v_daily_summary?local_date=eq.${d}&select=xp`, { headers })
        .then((r) => (r.ok ? r.json() : [])),
      sbRpc("my_stats", token).catch(() => null),
      fetch(`${SUPABASE_URL}/rest/v1/vocabularies?select=id&limit=1`, {
        headers: { ...headers, prefer: "count=exact" },
      })
        .then((r) => {
          const total = r.headers.get("content-range")?.split("/")[1]; // "0-0/23" → 23
          return total != null ? parseInt(total, 10) : null;
        })
        .catch(() => null),
    ]);
    const s = statsRows?.[0];
    return {
      loggedIn: true,
      xp: todayRows[0]?.xp || 0,
      vocabCount,
      stats: s
        ? {
            level: s.level,
            xpInto: s.xp_into_level,
            xpToNext: s.xp_to_next,
            streak: s.current_streak,
            longest: s.longest_streak,
            minutes: s.total_minutes,
          }
        : null,
    };
  } catch (_) {
    return { loggedIn: true, xp: null };
  }
}

// ---- Language Quest：升級 / 成就偵測 → 通知頁面放動畫 ----

async function sbRpc(name, token) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${token}`,
    },
    body: "{}",
  });
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.json();
}

async function questAfterFlush(token) {
  try {
    const [stats] = await sbRpc("my_stats", token);
    const newCodes = await sbRpc("sync_achievements", token); // 回傳「這次新解鎖的」codes

    const { questLevel } = await chrome.storage.local.get("questLevel");
    await chrome.storage.local.set({ questLevel: stats.level });

    // 第一次同步只記錄基準，不慶祝
    const levelUp = questLevel != null && stats.level > questLevel ? stats.level : null;

    let achievements = [];
    if (newCodes?.length) {
      const defs = await fetch(
        `${SUPABASE_URL}/rest/v1/achievement_defs?select=code,title&code=in.(${newCodes.join(",")})`,
        { headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${token}` } }
      ).then((r) => (r.ok ? r.json() : []));
      achievements = newCodes.map((c) => defs.find((d) => d.code === c)?.title || c);
    }

    if (!levelUp && !achievements.length) return;

    // 優先在 YouTube 分頁上放頁內動畫；沒有就退回系統通知
    const payload = { type: "quest-celebrate", level: levelUp, achievements };
    const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
    let delivered = false;
    for (const t of tabs) {
      try {
        await chrome.tabs.sendMessage(t.id, payload);
        delivered = true;
      } catch (_) {}
    }
    if (!delivered) {
      chrome.notifications.create(`quest-${Date.now()}`, {
        type: "basic",
        iconUrl: "icon128.png",
        title: levelUp ? `升級！LV ${levelUp} 🦜` : "成就解鎖！",
        message: achievements.length ? achievements.join("、") : "繼續保持！",
      });
    }
  } catch (e) {
    console.warn("[parrot] quest:", e);
  }
}

flushEvents(); // service worker 醒來時補送上次沒送完的

// ============================================================
// 每日開口（原 daily-english-gate）
// 每天第一次 focus Chrome → 通知推你去 ChatGPT（帶開場 prompt）；
// 只累積 ChatGPT 分頁在前景的時間，達標 → streak +1、上報 chatgpt_voice。
// ============================================================

const CHATGPT_URL = "https://chatgpt.com";
const ALARM_HEARTBEAT = "gate-heartbeat";
const ALARM_REMINDER = "gate-evening-reminder";

const GATE_DEFAULT_PROMPT =
  "Let's have a 10-minute English conversation practice. " +
  "Please start by asking me a casual question to get us going.";

const GATE_TOPICS = [
  "Daily life & routine", "Work & career goals", "Travel experiences",
  "Food & cooking", "News & current events", "Movies, TV & entertainment",
  "Technology & gadgets", "Health & fitness", "Hobbies & interests",
  "Culture & traditions", "Future plans & dreams", "Childhood memories",
  "Books & podcasts", "Environmental issues",
];

const todayStr = () => new Date().toISOString().slice(0, 10);

function dayOfYear(dateStr) {
  const d = new Date(dateStr);
  return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
}

// 該週的週一，當 streak 凍結的「本週」鍵
function weekKey(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

async function gateSettings() {
  const data = await chrome.storage.local.get({
    practiceMins: 10, reminderTime: "20:00", streakFreezeEnabled: true,
  });
  return {
    requiredSecs: data.practiceMins * 60,
    reminderTime: data.reminderTime,
    streakFreezeEnabled: data.streakFreezeEnabled,
  };
}

async function buildChatGptUrl() {
  const data = await chrome.storage.local.get({ customPrompt: "", topicsEnabled: true });
  let prompt = data.customPrompt.trim() || GATE_DEFAULT_PROMPT;
  if (data.topicsEnabled) {
    prompt += `\n\nToday's topic: ${GATE_TOPICS[dayOfYear(todayStr()) % GATE_TOPICS.length]}`;
  }
  const url = new URL(CHATGPT_URL);
  url.searchParams.set("q", prompt);
  return url.toString();
}

// ---- 全域 badge（loop.js 的 ON badge 是 per-tab，會蓋過這個，互不干擾）----

function gateComputeSecs(data, cap) {
  let total = data.accumulatedActiveSecs || 0;
  if (data.activeStart) total += (Date.now() - data.activeStart) / 1000;
  return Math.min(total, cap);
}

async function gateUpdateBadge() {
  const [data, { requiredSecs }] = await Promise.all([
    chrome.storage.local.get([
      "lastSessionDate", "sessionCompleted", "accumulatedActiveSecs", "activeStart", "streak",
    ]),
    gateSettings(),
  ]);
  if (data.sessionCompleted) {
    chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
    chrome.action.setBadgeText({ text: String(data.streak || 1) });
  } else if (data.lastSessionDate === todayStr()) {
    const minsLeft = Math.ceil((requiredSecs - gateComputeSecs(data, requiredSecs)) / 60);
    chrome.action.setBadgeBackgroundColor({ color: "#3b82f6" });
    chrome.action.setBadgeText({ text: `${minsLeft}m` });
  } else {
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    chrome.action.setBadgeText({ text: "!" });
  }
}

// ---- 每日第一次 focus 的提醒通知 ----

async function gateShowDailyPrompt() {
  const today = todayStr();
  const data = await chrome.storage.local.get(["lastSessionDate", "promptShownDate"]);
  if (data.lastSessionDate === today) return; // 今天已開始
  if (data.promptShownDate === today) return; // 今天已提醒過
  await chrome.storage.local.set({ promptShownDate: today });
  chrome.notifications.create("gate-prompt", {
    type: "basic",
    iconUrl: "icon128.png",
    title: "該練英文了！",
    message: "今天還沒開始，點這裡立刻開始練習",
    buttons: [{ title: "開始練習" }],
    requireInteraction: true,
    priority: 2,
  });
}

// ---- 開始 / 完成 ----

async function gateBeginSession(force = false) {
  const today = todayStr();
  const { lastSessionDate } = await chrome.storage.local.get("lastSessionDate");
  if (lastSessionDate === today && !force) return;
  await chrome.storage.local.set({ lastSessionDate: today });

  chrome.notifications.clear("gate-prompt");

  const tab = await chrome.tabs.create({ url: await buildChatGptUrl(), active: true });
  await chrome.storage.local.set({
    sessionCompleted: false,
    chatGptTabId: tab.id,
    accumulatedActiveSecs: 0,
    activeStart: Date.now(),
  });
  chrome.alarms.create(ALARM_HEARTBEAT, { periodInMinutes: 1 });
  gateUpdateBadge();
}

async function gateCompleteSession(data) {
  await chrome.storage.local.set({ sessionCompleted: true, activeStart: null });
  chrome.alarms.clear(ALARM_HEARTBEAT);

  const today = todayStr();
  await gateRecalcStats(today, data);

  // Language Quest：一天一筆，client_event_id 冪等，重複達標不會重複計分
  const { requiredSecs } = await gateSettings();
  enqueueEvent({
    source: "chatgpt_voice",
    activity: "conversation",
    duration_sec: requiredSecs,
    quantity: 0,
    client_event_id: `gate:${today}`,
    meta: {},
  }).catch((e) => console.warn("[parrot] gate enqueue:", e));

  const { streak } = await chrome.storage.local.get("streak");
  chrome.notifications.create("gate-complete", {
    type: "basic",
    iconUrl: "icon48.png",
    title: "英語練習完成！",
    message: `連續 ${streak} 天，繼續保持！`,
  });
  gateUpdateBadge();
}

// ---- active 時間追蹤 ----

async function gateActiveTabChanged(tabId) {
  const [data, { requiredSecs }] = await Promise.all([
    chrome.storage.local.get([
      "lastSessionDate", "sessionCompleted", "chatGptTabId",
      "accumulatedActiveSecs", "activeStart",
    ]),
    gateSettings(),
  ]);
  if (data.lastSessionDate !== todayStr() || data.sessionCompleted) return;

  const now = Date.now();
  let accumulated = data.accumulatedActiveSecs || 0;
  if (data.activeStart) accumulated += (now - data.activeStart) / 1000;
  accumulated = Math.min(accumulated, requiredSecs);

  await chrome.storage.local.set({
    accumulatedActiveSecs: Math.floor(accumulated),
    activeStart: tabId === data.chatGptTabId ? now : null,
  });

  if (accumulated >= requiredSecs) {
    await gateCompleteSession({ ...data, accumulatedActiveSecs: accumulated });
    return;
  }
  gateUpdateBadge();
}

async function gatePauseTracking() {
  const data = await chrome.storage.local.get([
    "lastSessionDate", "sessionCompleted", "accumulatedActiveSecs", "activeStart",
  ]);
  if (data.lastSessionDate !== todayStr() || data.sessionCompleted || !data.activeStart) return;

  const { requiredSecs } = await gateSettings();
  const accumulated = Math.min(
    (data.accumulatedActiveSecs || 0) + (Date.now() - data.activeStart) / 1000,
    requiredSecs
  );
  await chrome.storage.local.set({ accumulatedActiveSecs: Math.floor(accumulated), activeStart: null });
  gateUpdateBadge();
}

// ---- streak / 週統計（含每週一次的凍結）----

async function gateRecalcStats(today, prevData) {
  const { completedDays } = await chrome.storage.local.get("completedDays");
  const days = completedDays || {};
  days[today] = true;

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().slice(0, 10);
  const prevStreak = prevData.streak || 0;
  let streak;

  if (days[yStr]) {
    streak = prevStreak + 1;
  } else if (prevStreak > 0) {
    const { streakFreezeEnabled = true, freezeUsedWeek } =
      await chrome.storage.local.get({ streakFreezeEnabled: true, freezeUsedWeek: null });
    const thisWeek = weekKey(today);
    if (streakFreezeEnabled && freezeUsedWeek !== thisWeek) {
      streak = prevStreak; // 消耗凍結，保住 streak
      await chrome.storage.local.set({ freezeUsedWeek: thisWeek });
      chrome.notifications.create("gate-freeze", {
        type: "basic",
        iconUrl: "icon48.png",
        title: "Streak 凍結啟動！",
        message: `昨天沒練習，凍結保護了你的 ${prevStreak} 天紀錄`,
      });
    } else {
      streak = 1;
    }
  } else {
    streak = 1;
  }

  // 本週（週一起算）完成數
  const todayDate = new Date(today);
  const dow = todayDate.getDay();
  const daysFromMon = dow === 0 ? 6 : dow - 1;
  let weeklyCount = 0;
  for (let i = 0; i <= daysFromMon; i++) {
    const d = new Date(todayDate);
    d.setDate(todayDate.getDate() - i);
    if (days[d.toISOString().slice(0, 10)]) weeklyCount++;
  }

  // 清掉 90 天前的紀錄
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const key of Object.keys(days)) if (key < cutoffStr) delete days[key];

  await chrome.storage.local.set({ completedDays: days, streak, weeklyCount });
}

// ---- gate 的事件掛載 ----

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await gatePauseTracking();
    return;
  }
  await gateShowDailyPrompt();
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) await gateActiveTabChanged(tab.id);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { chatGptTabId } = await chrome.storage.local.get("chatGptTabId");
  if (tabId !== chatGptTabId) return;
  await gatePauseTracking();
  await chrome.storage.local.set({ chatGptTabId: null });
});

// 設定改了 → 重排提醒鬧鐘、重新檢查是否已達標
chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.reminderTime) await gateScheduleReminder();
  if (changes.practiceMins) {
    const requiredSecs = (changes.practiceMins.newValue || 10) * 60;
    const data = await chrome.storage.local.get([
      "lastSessionDate", "sessionCompleted", "accumulatedActiveSecs", "activeStart",
    ]);
    if (data.lastSessionDate === todayStr() && !data.sessionCompleted) {
      if (gateComputeSecs(data, requiredSecs) >= requiredSecs) {
        await gateCompleteSession(data);
        return;
      }
    }
    gateUpdateBadge();
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_HEARTBEAT) {
    const [data, { requiredSecs }] = await Promise.all([
      chrome.storage.local.get([
        "lastSessionDate", "sessionCompleted", "chatGptTabId",
        "accumulatedActiveSecs", "activeStart",
      ]),
      gateSettings(),
    ]);
    if (data.lastSessionDate !== todayStr() || data.sessionCompleted) {
      chrome.alarms.clear(ALARM_HEARTBEAT);
      return;
    }
    if (data.chatGptTabId && data.activeStart) {
      try {
        const tab = await chrome.tabs.get(data.chatGptTabId);
        const [win] = await chrome.windows.query({ focused: true });
        if (tab.active && win && tab.windowId === win.id) {
          const now = Date.now();
          const accumulated = Math.min(
            (data.accumulatedActiveSecs || 0) + (now - data.activeStart) / 1000,
            requiredSecs
          );
          await chrome.storage.local.set({
            accumulatedActiveSecs: Math.floor(accumulated),
            activeStart: now,
          });
          if (accumulated >= requiredSecs) {
            await gateCompleteSession({ ...data, accumulatedActiveSecs: accumulated });
            return;
          }
        }
      } catch {
        await chrome.storage.local.set({ activeStart: null, chatGptTabId: null });
      }
    }
    gateUpdateBadge();
  }

  if (alarm.name === ALARM_REMINDER) {
    const data = await chrome.storage.local.get(["lastSessionDate", "sessionCompleted", "streak"]);
    if (data.lastSessionDate === todayStr() && data.sessionCompleted) return;
    chrome.notifications.create("gate-reminder", {
      type: "basic",
      iconUrl: "icon48.png",
      title: "今天還沒練習英文！",
      message: `連續 ${data.streak || 0} 天的紀錄快斷掉了 😢`,
    });
  }
});

async function gateScheduleReminder() {
  const { reminderTime } = await chrome.storage.local.get({ reminderTime: "20:00" });
  const [hour, min] = reminderTime.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, min, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  chrome.alarms.create(ALARM_REMINDER, { when: next.getTime(), periodInMinutes: 24 * 60 });
}

chrome.notifications.onClicked.addListener((id) => {
  if (id === "gate-prompt") gateBeginSession();
});
chrome.notifications.onButtonClicked.addListener((id) => {
  if (id === "gate-prompt") gateBeginSession();
});

chrome.runtime.onStartup.addListener(async () => {
  gateScheduleReminder();
  await gateShowDailyPrompt();
});
chrome.runtime.onInstalled.addListener(() => {
  gateScheduleReminder();
  gateUpdateBadge();
});

// ---- 免費字典：IPA 音標 + 真人發音 + 英文定義 ----
async function dictionary(word) {
  const r = await fetch(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`
  );
  if (!r.ok) return null;
  const data = await r.json();
  const entry = data[0];
  if (!entry) return null;

  const ph = (entry.phonetics || []).find((p) => p.text) || {};
  const audio = (entry.phonetics || []).find((p) => p.audio)?.audio || null;

  return {
    ipa: ph.text || entry.phonetic || "",
    audio,
    defs: (entry.meanings || []).slice(0, 2).map((m) => ({
      pos: m.partOfSpeech,
      def: m.definitions?.[0]?.definition || "",
    })),
  };
}

// ---- Claude：中文意思 + KK 音標 + 句中語感 ----
async function claude(text, context, apiKey) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system:
        "你是英語學習助教，服務台灣的中階學習者。只輸出 JSON，不要 markdown 圍欄、不要任何其他文字。",
      messages: [
        {
          role: "user",
          content: `英文：${text}
出現的上下文：${context || "（無）"}

輸出這個 JSON：
{
  "zh": "在這個上下文裡的中文意思，簡短",
  "pos": "詞性（片語或句子就填空字串）",
  "kk": "KK 音標（單字才給，含斜線；片語或句子填空字串）",
  "sense": "一句話說明它在這裡的語感或用法，繁體中文",
  "example": "一個好記的英文例句",
  "example_zh": "例句的中文"
}`,
        },
      ],
    }),
  });

  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const data = await r.json();
  const raw = (data.content || [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .replace(/```json|```/g, "")
    .trim();
  return JSON.parse(raw);
}

// ---- 沒有 API key 時的備援翻譯（非官方端點，可能會壞）----
async function gtx(text) {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-TW&dt=t&q=" +
    encodeURIComponent(text);
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  return (data[0] || []).map((x) => x[0]).join("");
}
