# 專案：Parrot（英文學習 Chrome 擴充功能：跟讀＋查字＋每日開口）

單一 MV3 擴充功能（yt-ab-loop、word-lookup、daily-english-gate 三合一），個人自用，不上架。純 JS，**沒有 build step、零 npm 依賴**——請維持這樣，除非我明確要求。Supabase 一律用 REST（純 `fetch`），不要引入 supabase-js。

## 我是誰
前端工程師，主力 Vue / Nuxt。英文是中階，正在練聽力和 shadowing。
說話直接一點，不用鋪陳，講重點。

## 檔案

```
manifest.json    合併後的單一 manifest
background.js    service worker：路由 + 所有網路請求 + 每日開口（gate）模組
page.js          MAIN world：拿字幕軌、攔 /api/timedtext
loop.js/.css     YouTube 循環面板（原 yt-ab-loop 的 content.js）
lookup.js/.css   選字查詢小卡（全站生效）
popup.*          每日開口的進度 popup（進度環、streak、週曆、凍結）
options.*        設定頁：Anthropic API key + Supabase 登入 + 每日開口設定
files/           舊版 yt-ab-loop 的備份，不要動它
```

（page-veil 已移出這個 repo；daily-english-gate 已整個併進來，原 repo 可淘汰。）

## 工具列圖示的路由（容易忘）

manifest 的 `default_popup` 是 popup.html（開口進度）。background 會把 **YouTube 分頁的 popup 設成空字串**，所以在 YouTube 點圖示／Alt+L 走 `onClicked` → 切換練習面板；其他分頁則開 popup。badge 也有兩層：gate 的狀態 badge（🔴!／🔵Xm／🟢streak）是全域，loop 的「ON」badge 是 per-tab、會在該分頁蓋過全域。

## 每日開口（gate，原 daily-english-gate）

- 每天第一次 focus Chrome → 通知推你去 ChatGPT，網址帶 `?q=` 開場 prompt（可自訂＋每日主題輪換）。
- 只累積 **ChatGPT 分頁在前景**的時間（heartbeat alarm 每分鐘），切走就暫停。
- 達標（預設 10 分鐘）→ streak +1、通知、上報 `learning_events`（`source: 'chatgpt_voice'`，`client_event_id` = `gate:{date}`，一天一筆冪等）。
- Streak 凍結：每週可跳過一天不斷 streak（`freezeUsedWeek` 記週一的日期）。
- 晚上（預設 20:00）還沒完成會推播提醒。
- 狀態全在 `chrome.storage.local`：`lastSessionDate`、`sessionCompleted`、`accumulatedActiveSecs`、`activeStart`、`streak`、`completedDays` 等。

## 循環面板（loop.js，主力）

在 YouTube 播放頁插入面板。**預設不出現**，按工具列圖示或 `Alt+L` 才展開，狀態記在 `chrome.storage.local` 的 `on:{videoId}`。

- `page.js` 跑在 `"world": "MAIN"`，做兩件事：讀 `movie_player.getPlayerResponse().captions` 拿字幕軌；以及 monkey-patch `fetch`/`XHR` 攔截 YouTube 自己發的 `/api/timedtext`（使用者按 CC 時觸發，這是主要備援路徑）。用 `postMessage` 跟 content script 溝通。
- 循環引擎用 `requestAnimationFrame` 而非 `timeupdate`（後者一秒才 4 次，會多播 200ms，句尾會拖）。切句邏輯在 `buildSentences()`。
- **切句是核心設計**：ASR 字幕沒有標點，所以不按句號切，改**按停頓斷句**（`GAP = 0.65` 秒）。切出來的是講者的「氣口」，剛好一口氣跟讀得完。人工字幕才走標點分支。
- `LEAD` / `TAIL` 給每句前後留白，避免字頭字尾被切掉。
- 「每輪間隔」= 每次循環播完暫停 N 秒，讓使用者開口跟讀。
- 「先聽再看」= 句子清單文字 `blur()`，hover 才顯示。先聽寫再對答案。

## 選字查詢（lookup.js）

選取英文 → 浮出小卡。三個資料來源並行：

| 來源 | 給什麼 |
| --- | --- |
| `api.dictionaryapi.dev` | IPA 音標、真人發音 mp3、英文定義 |
| Claude API（`claude-haiku-4-5`） | 中文意思、KK 音標、句中語感、例句 |
| `translate.googleapis.com`（非官方） | 沒 API key 時的備援翻譯 |

**關鍵設計：翻譯會帶上下文。** 把整個句子送給 Claude，所以 `gut check` 裡的 `gut` 會翻成「憑直覺」而不是「腸子」。這是查字典做不到、但練聽力最需要的。

## Supabase 管線（跟 vocab-app 同一個專案）

- **生詞本**：小卡的「加入生詞本」→ upsert 進 `vocabularies` 表（vocab-app 的 SRS 直接吃得到）。去重靠先查再 PATCH/POST（該表沒有 unique(word)）；只覆蓋內容欄位，不動 `due`/`ease` 等排程欄位。RLS 開放 anon，**不用登入**。
- **Language Quest 記分**：每完成一輪循環 → `learning_events`（`source: 'ab_loop'`，每句 5 XP，daily cap 200）。RLS 要 `auth.uid()`，**必須登入**（options 頁，帳號同 vocab-app）。
- 事件先進 `chrome.storage.local` 的 `evQueue` 再批次送（5 秒攢一批）——MV3 service worker 隨時會被殺，SW 醒來會補送。`client_event_id` 唯一 + `ignore-duplicates`，重送不會重複計分。
- 登入用 GoTrue password grant，session 存 `chrome.storage.local` 的 `sbSession`，過期自動 refresh（refresh token 會輪換，refresh 要防並發——`background.js` 的 `refreshing` 鎖）。
- schema 的唯一真相來源：`~/Projects/vocab-app/supabase/migrations/001_language_quest_schema.sql`。

## 兩個一定要記住的技術約束

1. **content script 的 `fetch` 受頁面 CORS 限制。** 所有 API 呼叫必須放在 `background.js`（service worker 有 `host_permissions` 才不受限）。不要把 fetch 寫回 content script。
2. **Claude API 從瀏覽器直呼**需要 header `anthropic-dangerous-direct-browser-access: true`，少了就 403。

## Debug（三個獨立的 console）

- `loop.js` / `lookup.js` → 網頁本身的 DevTools
- `background.js` → `chrome://extensions` → 「Service Worker」連結
- `options.html` → 在選項頁按右鍵檢查

## 安全

Anthropic API key 和 Supabase session 都存在 `chrome.storage.local`。**不要 commit、不要把 Anthropic key 寫進任何檔案。**（`background.js` 裡的 Supabase anon key 是公開的，沒關係；權限在 RLS。）

## 待辦

- [x] 小卡加「加入生詞本」按鈕 → 存進 vocab-app 的 `vocabularies`
- [x] yt-ab-loop + word-lookup 合併成一個擴充功能
- [x] 命名：Parrot
- [x] 循環完成上報 `learning_events`（ab_loop）
- [x] daily-english-gate 併入（popup + 通知 + streak 凍結 + 上報 chatgpt_voice）
- [x] XP 即時 toast（+5 🍪）+ 升級 confetti + 成就解鎖卡 + popup 今日 XP 進度條
- [ ] 裝 `@types/chrome` + `jsconfig.json`，讓 `chrome.*` 有自動完成
- [ ] `lookup_words` 舊表：資料已搬到 `vocabularies`，到 SQL Editor drop 掉
- [x] vocab-app 改名 Parrot Nest；extension 互連（options 填 `nestUrl` → 小卡「去複習」、popup XP 條直達 /stats）
- [x] Parrot Nest 上線：https://parrotnest.vercel.app（舊 jargon-jar.vercel.app 會 307 轉址）；網址要填進 options 的 nestUrl
