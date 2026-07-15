// 每日開口的進度 popup（非 YouTube 分頁點工具列圖示時顯示）
const CIRCUMFERENCE = 2 * Math.PI * 52;

const ringFg      = document.getElementById("ring-fg");
const timeDisplay = document.getElementById("time-display");
const targetLabel = document.getElementById("target-label");
const statusText  = document.getElementById("status-text");
const streakVal   = document.getElementById("streak-val");
const weeklyVal   = document.getElementById("weekly-val");
const startBtn    = document.getElementById("start-btn");
const calEl       = document.getElementById("calendar");
const freezeEl    = document.getElementById("freeze-indicator");
const settingsBtn = document.getElementById("settings-btn");

const todayStr = () => new Date().toISOString().slice(0, 10);

function weekKey(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

function fmtSecs(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

const setRing = (p) => {
  ringFg.style.strokeDashoffset = CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, p)));
};

function computeActiveSecs(data, totalSecs) {
  let t = data.accumulatedActiveSecs || 0;
  if (data.activeStart) t += (Date.now() - data.activeStart) / 1000;
  return Math.min(t, totalSecs);
}

// ---- 本週日曆 ----
function renderCalendar(completedDays) {
  const today = todayStr();
  const todayDate = new Date(today);
  const dow = todayDate.getDay();
  const daysFromMon = dow === 0 ? 6 : dow - 1;
  const dayLabels = ["一", "二", "三", "四", "五", "六", "日"];

  calEl.innerHTML = "";
  for (let i = 0; i < 7; i++) {
    const d = new Date(todayDate);
    d.setDate(todayDate.getDate() - daysFromMon + i);
    const dStr = d.toISOString().slice(0, 10);

    const cell = document.createElement("div");
    cell.className = "cal-day";

    const dot = document.createElement("div");
    dot.className = "cal-dot"
      + (completedDays?.[dStr] ? " done" : "")
      + (dStr === today ? " today" : "")
      + (dStr > today ? " future" : "");

    const lbl = document.createElement("div");
    lbl.className = "cal-label" + (dStr === today ? " today" : "");
    lbl.textContent = dayLabels[i];

    cell.appendChild(dot);
    cell.appendChild(lbl);
    calEl.appendChild(cell);
  }
}

// ---- 凍結指示 ----
function renderFreeze(data) {
  const enabled = data.streakFreezeEnabled !== false;
  if (!enabled || !(data.streak > 0)) {
    freezeEl.className = "hidden";
    return;
  }
  const used = data.freezeUsedWeek === weekKey(todayStr());
  freezeEl.textContent = used ? "❄️ 本週凍結已使用" : "🧊 本週凍結可用";
  freezeEl.className = used ? "freeze-used" : "freeze-available";
}

// ---- 主渲染 ----
function render(data) {
  const today = todayStr();
  const totalMins = data.practiceMins || 10;
  const totalSecs = totalMins * 60;

  streakVal.textContent = data.streak ?? 0;
  weeklyVal.textContent = `${data.weeklyCount ?? 0}/7`;
  targetLabel.textContent = `/ ${totalMins} 分鐘目標`;
  renderCalendar(data.completedDays);
  renderFreeze(data);

  if (data.lastSessionDate !== today) {
    timeDisplay.textContent = "0:00";
    setRing(0);
    ringFg.classList.remove("done");
    statusText.textContent = "今日尚未開始練習";
    statusText.className = "";
    startBtn.classList.remove("hidden");
    startBtn.disabled = false;
    startBtn.textContent = "立即開始";
    return;
  }

  startBtn.classList.add("hidden");

  if (data.sessionCompleted) {
    timeDisplay.textContent = fmtSecs(totalSecs);
    setRing(1);
    ringFg.classList.add("done");
    statusText.textContent = "✓ 今日練習已完成！";
    statusText.className = "done";
    return;
  }

  ringFg.classList.remove("done");
  const activeSecs = computeActiveSecs(data, totalSecs);
  timeDisplay.textContent = fmtSecs(activeSecs);
  setRing(activeSecs / totalSecs);

  if (data.activeStart) {
    statusText.textContent = "ChatGPT 使用中 ▶";
    statusText.className = "active";
  } else {
    statusText.textContent = "切換到 ChatGPT 分頁繼續";
    statusText.className = "paused";
  }
}

async function refresh() {
  const data = await chrome.storage.local.get([
    "lastSessionDate", "sessionCompleted",
    "accumulatedActiveSecs", "activeStart",
    "streak", "weeklyCount", "completedDays", "practiceMins",
    "streakFreezeEnabled", "freezeUsedWeek",
  ]);
  render(data);
}

setInterval(refresh, 1000);
refresh();

startBtn.addEventListener("click", () => {
  startBtn.disabled = true;
  startBtn.textContent = "開啟中...";
  chrome.runtime.sendMessage({ type: "gate-start" }, () => setTimeout(refresh, 400));
});

settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
