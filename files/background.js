/** 工具列圖示 / Alt+L → 通知該分頁的 content script 切換面板 */

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https:\/\/(www\.)?youtube\.com\//.test(tab.url || "")) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "ytab-toggle" });
  } catch (_) {
    // content script 尚未注入（剛安裝或剛重新載入擴充功能）→ 刷新分頁
    chrome.tabs.reload(tab.id);
  }
});

// content script 回報開關狀態 → 在圖示上顯示 ON
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "ytab-state" || !sender.tab?.id) return;
  chrome.action.setBadgeText({ tabId: sender.tab.id, text: msg.on ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#3ea6ff" });
});
