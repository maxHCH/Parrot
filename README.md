# Word Lookup（選字查詢・音標・朗讀）

選取任何網頁上的英文 → 跳出小卡：**中文意思 + 音標 + 發音朗讀 + 例句**。
在 AB Loop 的字幕句子清單上也能直接選字查。

## 安裝

1. `chrome://extensions` → 開發人員模式 → 載入未封裝項目
2. 點擴充功能圖示 → 開啟「選項」→ 填入 **Anthropic API key** → 儲存

> key 留空也能用，但只會有基本翻譯 + IPA 音標，沒有句中語感和例句。

## 使用

**選取英文 → 小卡自動跳出。**

| 元素 | 說明 |
| --- | --- |
| 🔊（標題旁） | 朗讀這個字。有真人發音就用真人的，否則用系統 TTS（語速 0.85 慢速） |
| **IPA** | 來自免費字典 API，真實查到的音標 |
| **KK** | 由 Claude 產生（台灣學校教的那套） |
| 中文意思 | **依上下文翻譯** —— 會把整句話一起送給 Claude，不是孤立查字 |
| 一句話語感 | 這個字在這個句子裡到底在幹嘛 |
| 例句 + 🔊 | 可單獨朗讀 |

`Esc` 或點旁邊關閉。選一整句話也可以（會翻譯 + 朗讀，但不查字典）。

## 三個資料來源

| 來源 | 給什麼 | 需要 key |
| --- | --- | --- |
| `api.dictionaryapi.dev` | IPA 音標、**真人發音 mp3**、英文定義 | ✗ 免費 |
| Claude API（`claude-haiku-4-5`） | 中文意思、KK 音標、句中語感、例句 | ✓ |
| `translate.googleapis.com`（非官方端點） | 沒填 key 時的備援翻譯 | ✗ |

## 為什麼上下文翻譯很關鍵

一般字典查 `gut` 給你「腸子」。但在 `gut check` 裡它是「憑直覺判斷」。
這支會把**整個句子**一起送過去，所以拿到的是它**在你聽到的那句話裡**的意思。這是查字典做不到、但你練聽力最需要的。

## 音標說明

`api.dictionaryapi.dev` 回的是 **IPA**（國際音標），不是 KK。
KK 是 Claude 產生的，準確度很高但**偶爾會錯**，當參考就好 —— **真正的標準答案是那個 🔊 真人發音**。

## 技術重點

**所有 API 呼叫都在 `background.js`**，不在 content script 裡。
因為 content script 的 `fetch` 會被當成「頁面的 origin」而受 CORS 擋；service worker 有 `host_permissions` 就不受限。這是這類擴充功能最常卡住的地方。

Claude API 從瀏覽器直呼需要這個 header：

```js
"anthropic-dangerous-direct-browser-access": "true"
```

## 安全

API key 存在 `chrome.storage.local`，只在你自己的瀏覽器。
**不要把這個資料夾（含 key）分享、上傳 git、或發布到商店。** 自用沒問題，公開就是把 key 送人。

## 檔案

| 檔案 | 作用 |
| --- | --- |
| `manifest.json` | MV3；`host_permissions` 給三個 API 網域 |
| `background.js` | 字典 + Claude + 備援翻譯，三路並行 |
| `content.js` | 選取偵測、小卡、朗讀（`Audio` / `speechSynthesis`） |
| `lookup.css` | 小卡樣式 |
| `options.html/js` | API key 設定 |

## 下一步

小卡加一顆「加入生詞本」，把 `{word, ipa, zh, example, 來源網址}` 丟進你的 Supabase —— 就直接接上你那個 Nuxt 單字卡 App 了。要的話跟我說。
