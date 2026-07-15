// ---- Anthropic API key ----
const input = document.getElementById("key");
const saved = document.getElementById("saved");

chrome.storage.local.get("apiKey", (v) => (input.value = v.apiKey || ""));

document.getElementById("save").onclick = () => {
  chrome.storage.local.set({ apiKey: input.value.trim() }, () => {
    saved.textContent = "已儲存 ✓";
    setTimeout(() => (saved.textContent = ""), 1800);
  });
};

// ---- Supabase 登入（Language Quest 記分用）----
const form = document.getElementById("login-form");
const done = document.getElementById("login-done");
const msg = document.getElementById("login-msg");

function renderStatus() {
  chrome.runtime.sendMessage({ type: "sb-status" }, (s) => {
    if (!s) return;
    form.hidden = s.loggedIn;
    done.hidden = !s.loggedIn;
    if (s.loggedIn) {
      document.getElementById("login-email").textContent = s.email || "";
      document.getElementById("pending-note").textContent =
        s.pending ? `（還有 ${s.pending} 筆記錄排隊中，會自動補送）` : "";
    }
  });
}

document.getElementById("login").onclick = (e) => {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  if (!email || !password) return;
  e.target.disabled = true;
  msg.textContent = "登入中…";
  msg.className = "";
  chrome.runtime.sendMessage({ type: "sb-login", email, password }, (r) => {
    e.target.disabled = false;
    if (r?.ok) {
      msg.textContent = "";
      renderStatus();
    } else {
      msg.textContent = `登入失敗：${r?.error || "未知錯誤"}`;
      msg.className = "err";
    }
  });
};

document.getElementById("logout").onclick = () => {
  chrome.runtime.sendMessage({ type: "sb-logout" }, renderStatus);
};

renderStatus();

// ---- 每日開口（gate）設定：直接讀寫 storage，background 監聽變更自動生效 ----
const GATE_DEFAULT_PROMPT =
  "Let's have a 10-minute English conversation practice. " +
  "Please start by asking me a casual question to get us going.";

const mins = document.getElementById("practice-mins");
const reminder = document.getElementById("reminder-time");
const gatePrompt = document.getElementById("gate-prompt");
const topics = document.getElementById("topics-toggle");
const freeze = document.getElementById("freeze-toggle");
const gateSaved = document.getElementById("gate-saved");

let gateSavedTimer = null;
function gateShowSaved() {
  gateSaved.textContent = "已儲存 ✓";
  clearTimeout(gateSavedTimer);
  gateSavedTimer = setTimeout(() => (gateSaved.textContent = ""), 1800);
}

chrome.storage.local.get(
  { practiceMins: 10, reminderTime: "20:00", customPrompt: "", topicsEnabled: true, streakFreezeEnabled: true },
  (d) => {
    mins.value = d.practiceMins;
    reminder.value = d.reminderTime;
    gatePrompt.value = d.customPrompt || GATE_DEFAULT_PROMPT;
    topics.checked = d.topicsEnabled;
    freeze.checked = d.streakFreezeEnabled;
  }
);

mins.onchange = () => {
  let v = parseInt(mins.value, 10);
  if (isNaN(v) || v < 1) v = 1;
  if (v > 60) v = 60;
  mins.value = v;
  chrome.storage.local.set({ practiceMins: v }, gateShowSaved);
};
reminder.onchange = () => chrome.storage.local.set({ reminderTime: reminder.value }, gateShowSaved);
gatePrompt.onblur = () => chrome.storage.local.set({ customPrompt: gatePrompt.value.trim() }, gateShowSaved);
topics.onchange = () => chrome.storage.local.set({ topicsEnabled: topics.checked }, gateShowSaved);
freeze.onchange = () => chrome.storage.local.set({ streakFreezeEnabled: freeze.checked }, gateShowSaved);
