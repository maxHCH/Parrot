(() => {
  "use strict";

  const MAX_LEN = 300;
  let pop = null;
  let lastText = "";

  // ---------- 朗讀 ----------
  // 一律用瀏覽器 TTS：單字、重播、例句都同一個聲音，
  // 不用字典的真人發音 mp3（跟 TTS 音調不一致，聽起來像兩個人）。
  function speak(text) {
    stopSpeak();
    speakTTS(text);
  }

  function speakTTS(text) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = 0.85;                      // 學習用，慢一點
    const v = speechSynthesis
      .getVoices()
      .find((x) => /en-US/i.test(x.lang) && /natural|google|samantha/i.test(x.name))
      || speechSynthesis.getVoices().find((x) => /^en/i.test(x.lang));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }

  function stopSpeak() {
    speechSynthesis.cancel();
  }

  speechSynthesis.getVoices(); // 觸發語音清單載入

  // ---------- 取得上下文句子 ----------
  function contextOf(sel) {
    const node = sel.anchorNode;
    const el = node?.nodeType === 3 ? node.parentElement : node;
    const block = el?.closest("p, li, td, blockquote, h1, h2, h3, div, span");
    const t = (block?.innerText || "").replace(/\s+/g, " ").trim();
    return t.length > 400 ? t.slice(0, 400) : t;
  }

  // ---------- 面板 ----------
  function close() {
    stopSpeak();
    pop?.remove();
    pop = null;
    lastText = "";
  }

  function show(rect, text, context) {
    close();
    pop = document.createElement("div");
    pop.id = "wl-pop";
    pop.innerHTML = `
      <div class="wl-top">
        <span class="wl-word">${esc(text)}</span>
        <button class="wl-speak" title="朗讀">🔊</button>
        <button class="wl-x" title="關閉">×</button>
      </div>
      <div class="wl-body"><span class="wl-loading">查詢中…</span></div>
    `;
    document.body.appendChild(pop);

    // 定位：預設在選取範圍下方，超出視窗就翻到上面
    const top = window.scrollY + rect.bottom + 8;
    const left = Math.min(
      window.scrollX + rect.left,
      window.scrollX + window.innerWidth - pop.offsetWidth - 12
    );
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.max(window.scrollX + 8, left)}px`;
    if (rect.bottom + pop.offsetHeight + 16 > window.innerHeight) {
      pop.style.top = `${window.scrollY + rect.top - pop.offsetHeight - 8}px`;
    }

    pop.querySelector(".wl-x").onclick = close;
    pop.querySelector(".wl-speak").onclick = () => speak(text);

    speak(text); // 開卡先唸一次

    try {
      chrome.runtime.sendMessage({ type: "lookup", text, context }, (res) => {
        if (!pop) return;
        if (chrome.runtime.lastError || !res) return fill(`<span class="wl-err">查詢失敗</span>`);
        render(res, context);
      });
    } catch (_) {
      // 擴充功能重新載入後的孤兒 script：提示重新整理即可
      fill(`<span class="wl-err">擴充功能已更新，請重新整理此頁</span>`);
    }
  }

  // 從上下文抓出包含該字的句子，當沒有 AI 例句時的備援
  // （vocabularies.example_sentence 是 NOT NULL，而且真實出處本來就是最好的例句）
  function sentenceFrom(context, word) {
    if (!context) return null;
    const w = word.toLowerCase();
    const s = context.split(/(?<=[.!?])\s+/).find((x) => x.toLowerCase().includes(w));
    return (s || "").trim().slice(0, 300) || null;
  }

  const esc = (s) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const fill = (html) => { if (pop) pop.querySelector(".wl-body").innerHTML = html; };

  function render(res, context) {
    const { dict, ai, fallbackZh, hasKey } = res;
    const rows = [];

    // 音標
    const ipa = dict?.ipa || "";
    const kk = ai?.kk || "";
    if (ipa || kk) {
      rows.push(`<div class="wl-ph">
        ${ipa ? `<span class="wl-ipa">IPA ${esc(ipa)}</span>` : ""}
        ${kk ? `<span class="wl-kk">KK ${esc(kk)}</span>` : ""}
      </div>`);
    }

    // 中文
    const zh = ai?.zh || fallbackZh;
    if (zh) {
      rows.push(`<div class="wl-zh">
        ${ai?.pos ? `<span class="wl-pos">${esc(ai.pos)}</span>` : ""}${esc(zh)}
      </div>`);
    }

    // 句中語感
    if (ai?.sense) rows.push(`<div class="wl-sense">${esc(ai.sense)}</div>`);

    // 英文定義
    if (dict?.defs?.length) {
      rows.push(
        `<ul class="wl-defs">` +
          dict.defs
            .map((d) => `<li><em>${esc(d.pos)}</em> ${esc(d.def)}</li>`)
            .join("") +
          `</ul>`
      );
    }

    // 例句
    if (ai?.example) {
      rows.push(`<div class="wl-ex">
        <button class="wl-ex-speak" title="朗讀例句">🔊</button>
        <div>
          <div class="wl-ex-en">${esc(ai.example)}</div>
          ${ai.example_zh ? `<div class="wl-ex-zh">${esc(ai.example_zh)}</div>` : ""}
        </div>
      </div>`);
    }

    if (!rows.length) rows.push(`<span class="wl-err">查不到這個字</span>`);

    // 加入生詞本（有查到內容才給存；太長的選取通常是整段句子，不是要背的字）
    const savable = (zh || ipa || kk) && res.text.length <= 80;
    if (savable) rows.push(`<button class="wl-save">＋ 加入生詞本</button>`);

    if (!hasKey)
      rows.push(
        `<div class="wl-tip">未設定 Claude API key，只提供基本翻譯。到擴充功能的「選項」填入可得到句中語感與例句。</div>`
      );

    fill(rows.join(""));

    const exBtn = pop.querySelector(".wl-ex-speak");
    if (exBtn) exBtn.onclick = () => speak(ai.example);

    const saveBtn = pop.querySelector(".wl-save");
    if (saveBtn)
      saveBtn.onclick = () => {
        saveBtn.disabled = true;
        saveBtn.textContent = "加入中…";
        // fetch 一律在 background（CORS），這裡只發 message
        try {
        chrome.runtime.sendMessage(
          {
            type: "save",
            payload: {
              word: res.text.trim().toLowerCase(), // 統一小寫，配合 word 去重
              ipa: dict?.ipa || null,
              zh: zh || null,
              example: ai?.example || sentenceFrom(context, res.text),
              example_zh: ai?.example ? ai?.example_zh || null : null,
              source_url: location.href,
            },
          },
          (r) => {
            if (!pop) return;
            if (r?.needLogin) {
              // RLS 收緊後生詞本是帳號私有，重試也沒用，先去登入
              saveBtn.textContent = "先到擴充功能選項頁登入";
            } else if (chrome.runtime.lastError || !r?.ok) {
              saveBtn.disabled = false;
              saveBtn.textContent = "加入失敗，再試一次";
              console.warn("[word-lookup] save:", r?.error || chrome.runtime.lastError?.message);
            } else {
              saveBtn.textContent = "✓ 已加入生詞本";
              saveBtn.classList.add("wl-saved");
              if (nestUrl) {
                const go = document.createElement("a");
                go.className = "wl-nest";
                go.textContent = "去複習 →";
                go.href = `${nestUrl}/review`;
                go.target = "_blank";
                go.rel = "noopener";
                saveBtn.after(go);
              }
            }
          }
        );
        } catch (_) {
          saveBtn.textContent = "擴充功能已更新，請重新整理此頁";
        }
      };
  }

  // ---------- 觸發條件 ----------
  // 預設只在練習模式（AB LOOP 面板開著）才啟用選字查詢，
  // 免得平常瀏覽的雙擊也彈卡。options 可開「全站查詢」。
  let everywhere = false;
  let nestUrl = "";
  try {
    chrome.storage.local.get(["lookupEverywhere", "nestUrl"], (v) => {
      everywhere = !!v?.lookupEverywhere;
      nestUrl = v?.nestUrl || "";
    });
    chrome.storage.onChanged.addListener((ch) => {
      if (ch.lookupEverywhere) everywhere = !!ch.lookupEverywhere.newValue;
      if (ch.nestUrl) nestUrl = ch.nestUrl.newValue || "";
    });
  } catch (_) {}

  const lookupActive = () => everywhere || !!document.getElementById("ytab-panel");

  // ---------- 觸發 ----------
  document.addEventListener("mouseup", (e) => {
    if (e.target.closest?.("#wl-pop")) return;
    if (!lookupActive()) return;

    setTimeout(() => {
      const sel = window.getSelection();
      const text = (sel?.toString() || "").trim();

      if (!text || text.length > MAX_LEN || !/[a-zA-Z]/.test(text)) return close();
      if (text === lastText && pop) return;

      lastText = text;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      show(rect, text, contextOf(sel));
    }, 10);
  });

  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest?.("#wl-pop")) close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
})();
