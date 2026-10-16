// AI Console 크롬 연결 — 모델의 브라우저 명령을 실제 크롬에서 실행한다.
//
// 명령은 AI Console 페이지(bridge.js)에서만 받는다. 사용자가 팝업에 적은 주소의
// 페이지가 아니면 거절한다.
//
// 지키는 것:
//   - 사용자가 허용한 사이트에서만 읽고 조작한다. 처음 보는 사이트는 페이지에 확인을
//     요청하고(needsConfirm), 사용자가 허용하면 허용 목록에 넣는다.
//   - 제출·전송·구매·삭제처럼 되돌리기 어려워 보이는 동작은 매번 확인을 요청한다.
//   - 비밀번호 칸에는 입력하지 않는다. AI Console 자신과 크롬 웹 스토어는 다루지 않는다.
//
// 모델에게는 화면 그림이 아니라 글로 된 페이지 요약(본문 + 번호 붙은 조작 요소)을 준다.

const MAX_TEXT = 6000;
const MAX_ELEMENTS = 150;
const LOAD_TIMEOUT_MS = 20000;

// 누르기 전에 사용자 확인을 받을 낱말. 넓게 잡는다 — 묻지 않아서 생기는 사고가 한 번
// 더 묻는 수고보다 크다.
const RISK_SOURCE =
  "(구매|결제|주문|송금|이체|삭제|탈퇴|전송|보내기|제출|등록|게시|발행|확인|동의|가입|로그아웃|저장|" +
  "pay|buy|purchase|order|checkout|delete|remove|send|submit|post|publish|confirm|agree|sign ?up|log ?out|transfer|save)";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- 설정

async function getSettings() {
  const s = await chrome.storage.local.get(["appOrigin", "enabled", "allowedSites"]);
  return {
    appOrigin: typeof s.appOrigin === "string" ? s.appOrigin : "",
    enabled: s.enabled !== false,
    allowedSites: Array.isArray(s.allowedSites) ? s.allowedSites : [],
  };
}

/** 매치 패턴에는 포트를 쓸 수 없다. 포트까지는 bridge.js 가 location.origin 으로 가린다. */
function matchPatternFor(origin) {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}

/** 중계(bridge.js)를 사용자가 정한 AI Console 주소에만 붙인다. */
async function syncBridgeRegistration() {
  const { appOrigin } = await getSettings();
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ["aic-bridge"] });
  if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: ["aic-bridge"] });
  if (!appOrigin) return;
  const pattern = matchPatternFor(appOrigin);
  await chrome.scripting.registerContentScripts([
    { id: "aic-bridge", matches: [pattern], js: ["bridge.js"], runAt: "document_start", persistAcrossSessions: true },
  ]);
  // 이미 열려 있는 AI Console 탭에도 바로 붙인다 — 새로고침하지 않아도 연결되게.
  for (const tab of await chrome.tabs.query({ url: pattern })) {
    try {
      if (tab.id !== undefined && tab.url && new URL(tab.url).origin === appOrigin) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["bridge.js"] });
      }
    } catch {
      // 막 닫히는 탭 등 — 다음 새로고침에서 붙는다.
    }
  }
}

chrome.runtime.onInstalled.addListener(() => void syncBridgeRegistration());
chrome.runtime.onStartup.addListener(() => void syncBridgeRegistration());

// ---------------------------------------------------------------- 메시지

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.kind === "settings-changed") {
    syncBridgeRegistration().then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
    );
    return true;
  }
  if (message?.kind !== "command") return false;
  handleCommand(message.command, sender).then(sendResponse, (err) =>
    sendResponse({ ok: false, error: `브라우저 명령 실행 중 오류: ${err?.message ?? err}` }),
  );
  return true;
});

async function handleCommand(command, sender) {
  const settings = await getSettings();
  let senderOrigin = "";
  try {
    senderOrigin = new URL(sender.url ?? "").origin;
  } catch {
    // 아래에서 거절된다.
  }
  if (sender.id !== chrome.runtime.id || !settings.appOrigin || senderOrigin !== settings.appOrigin) {
    return { ok: false, error: "연결된 AI Console 주소가 아닌 곳에서 온 요청이라 거절했습니다." };
  }
  if (!settings.enabled) {
    return { ok: false, error: "사용자가 확장 프로그램에서 크롬 연결을 꺼 두었습니다." };
  }
  const name = command?.name;
  const args = command?.args && typeof command.args === "object" ? command.args : {};
  const ctx = {
    settings,
    confirm: command?.confirm && typeof command.confirm === "object" ? command.confirm : {},
    // 명령을 보낸 AI Console 탭. 새 탭이 앞으로 튀어나오면 이 탭을 다시 앞으로 돌린다.
    appTabId: sender.tab?.id ?? null,
  };
  switch (name) {
    case "browser_tabs":
      return listTabs(ctx);
    case "browser_open":
      return openUrl(args, ctx);
    case "browser_read":
      return readCommand(args, ctx);
    case "browser_click":
      return elementAction(args, ctx, "click");
    case "browser_type":
      return elementAction(args, ctx, "type");
    case "browser_scroll":
      return scrollCommand(args, ctx);
    case "browser_back":
      return backCommand(args, ctx);
    default:
      return { ok: false, error: `알 수 없는 브라우저 명령: ${name}` };
  }
}

// ---------------------------------------------------------------- 사이트·탭

/**
 * 이 주소를 다뤄도 되는가. 되면 null, 아니면 모델에게 돌려줄 응답.
 * 처음 보는 사이트는 사용자 확인을 요청한다. 사용자가 허용해 다시 보낸 명령에는
 * confirm.allowSite 가 실려 오고, 그때 허용 목록에 넣는다.
 */
async function siteGate(url, ctx) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: `주소가 올바르지 않습니다: ${url}` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: `http·https 페이지만 다룰 수 있습니다(${u.protocol}).` };
  }
  if (u.origin === ctx.settings.appOrigin) return { ok: false, error: "AI Console 자신은 조작하지 않습니다." };
  if (u.hostname === "chromewebstore.google.com" || u.hostname === "chrome.google.com") {
    return { ok: false, error: "크롬 웹 스토어는 조작할 수 없습니다." };
  }
  const host = u.hostname;
  if (ctx.settings.allowedSites.includes(host)) return null;
  if (ctx.confirm.allowSite === host) {
    ctx.settings.allowedSites = [...ctx.settings.allowedSites, host];
    await chrome.storage.local.set({ allowedSites: ctx.settings.allowedSites });
    return null;
  }
  return {
    needsConfirm: { kind: "site", host, message: `모델이 ${host} 에서 크롬을 읽고 조작하려 합니다. 이 사이트를 허용할까요?` },
  };
}

function isAllowed(url, ctx) {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && ctx.settings.allowedSites.includes(u.hostname);
  } catch {
    return false;
  }
}

async function lastTabId() {
  const { lastTabId } = await chrome.storage.session.get(["lastTabId"]);
  return Number.isInteger(lastTabId) ? lastTabId : null;
}

async function rememberTab(tabId) {
  await chrome.storage.session.set({ lastTabId: tabId });
}

async function resolveTab(args) {
  const id = Number.isInteger(args.tab_id) ? args.tab_id : await lastTabId();
  if (id === null) return { error: "다룰 탭이 없습니다. 먼저 browser_open 으로 페이지를 여세요." };
  try {
    return { tab: await chrome.tabs.get(id) };
  } catch {
    return { error: `탭 ${id} 을(를) 찾을 수 없습니다. browser_tabs 로 다시 확인하세요.` };
  }
}

async function waitForLoad(tabId) {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  await sleep(150);
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status === "complete") break;
    await sleep(200);
  }
  // 그려진 뒤 스크립트가 내용을 채우는 페이지가 많다.
  await sleep(500);
}

async function run(tabId, func, args) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return injection?.result;
}

// ---------------------------------------------------------------- 명령

async function listTabs(ctx) {
  const last = await lastTabId();
  const tabs = await chrome.tabs.query({});
  const lines = [];
  let hidden = 0;
  for (const tab of tabs) {
    if (!tab.url || !isAllowed(tab.url, ctx)) {
      hidden++;
      continue;
    }
    const marks = [tab.active ? "보는 중" : "", tab.id === last ? "최근 작업" : ""].filter(Boolean).join(", ");
    lines.push(`[탭 ${tab.id}] ${tab.title ?? ""} — ${tab.url}${marks ? ` (${marks})` : ""}`);
  }
  const head = lines.length > 0 ? lines.join("\n") : "허용된 사이트의 탭이 없습니다.";
  return {
    ok: true,
    result: `${head}\n(허용되지 않은 사이트의 탭 ${hidden}개는 보이지 않습니다. 새 페이지는 browser_open 으로 여세요.)`,
  };
}

async function openUrl(args, ctx) {
  let url = String(args.url ?? "").trim();
  if (!url) return { ok: false, error: "url 이 비었습니다." };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
  const gate = await siteGate(url, ctx);
  if (gate) return gate;
  let tabId = null;
  const last = await lastTabId();
  if (args.new_tab === false && last !== null) {
    try {
      await chrome.tabs.update(last, { url });
      tabId = last;
    } catch {
      // 탭이 닫혔다 — 새로 연다.
    }
  }
  if (tabId === null) {
    // 앞으로 가져오지 않는다. 사용자는 AI Console 탭에서 진행과 확인 창을 본다.
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
  }
  await waitForLoad(tabId);
  return afterAction(tabId, ctx, `${url} 을(를) 열었습니다.`);
}

async function readCommand(args, ctx) {
  const { tab, error } = await resolveTab(args);
  if (error) return { ok: false, error };
  const gate = await siteGate(tab.url ?? "", ctx);
  if (gate) return gate;
  const offset = Number.isInteger(args.text_offset) && args.text_offset > 0 ? args.text_offset : 0;
  return readTab(tab.id, offset);
}

async function readTab(tabId, textOffset = 0, note = "") {
  const snap = await run(tabId, snapshotPage, [MAX_TEXT, MAX_ELEMENTS, textOffset]);
  await rememberTab(tabId);
  return { ok: true, result: formatSnapshot(tabId, snap, textOffset, note) };
}

/** 동작 뒤의 페이지. 허용 안 된 사이트로 옮겨 갔으면 읽지 않고 그 사실만 알린다. */
async function afterAction(tabId, ctx, message) {
  const tab = await chrome.tabs.get(tabId);
  await rememberTab(tabId);
  if (!isAllowed(tab.url ?? "", ctx)) {
    return {
      ok: true,
      result:
        `${message}\n페이지가 ${tab.url} 로 바뀌었습니다. 이 사이트는 아직 허용되지 않아 내용을 읽지 않았습니다. ` +
        "계속하려면 browser_read 를 호출하세요(사용자에게 허용을 묻습니다).",
    };
  }
  return readTab(tabId, 0, message);
}

async function elementAction(args, ctx, kind) {
  const { tab, error } = await resolveTab(args);
  if (error) return { ok: false, error };
  const gate = await siteGate(tab.url ?? "", ctx);
  if (gate) return gate;
  const ref = String(args.ref ?? "").replace(/^\[|\]$/g, "");
  if (!/^e\d+$/.test(ref)) return { ok: false, error: "ref 는 browser_read 결과의 e12 같은 번호여야 합니다." };

  const info = await run(tab.id, inspectElement, [ref, RISK_SOURCE]);
  if (!info?.found) {
    return { ok: false, error: `${ref} 요소를 찾지 못했습니다. 페이지가 바뀌었을 수 있으니 browser_read 로 다시 읽으세요.` };
  }
  if (kind === "type" && info.password) {
    return { ok: false, error: "비밀번호 칸에는 입력하지 않습니다. 사용자에게 직접 입력해 달라고 하세요." };
  }
  const text = String(args.text ?? "");
  const risky = kind === "click" ? info.risky : Boolean(args.submit) && info.submitRisky;
  if (risky && ctx.confirm.action !== true) {
    const host = new URL(tab.url).hostname;
    return {
      needsConfirm: {
        kind: "action",
        host,
        message:
          kind === "click"
            ? `${host} 에서 "${info.label || ref}" 을(를) 누르려 합니다.`
            : `${host} 의 "${info.label || ref}" 칸에 "${text.slice(0, 80)}" 을(를) 입력하고 제출하려 합니다.`,
      },
    };
  }

  // 누른 뒤에 생긴 탭을 모은다(target=_blank 링크 등).
  const created = [];
  const onCreated = (t) => created.push(t);
  chrome.tabs.onCreated.addListener(onCreated);
  const done =
    kind === "click"
      ? await run(tab.id, clickElement, [ref])
      : await run(tab.id, typeIntoElement, [ref, text, Boolean(args.submit)]);
  await sleep(600);
  if (kind === "click" && created.length === 0) await sleep(900);
  chrome.tabs.onCreated.removeListener(onCreated);
  if (!done?.ok) return done ?? { ok: false, error: "동작을 실행하지 못했습니다." };

  // 새 탭으로 열리는 링크면 그 탭으로 옮겨 간다. openerTabId 는 믿을 수 없다 — 누른 탭이
  // 아니라 명령을 보낸 AI Console 탭이 찍혀 나오기도 한다(실측). 누른 직후에 생긴 탭으로 가린다.
  const opened = created[0];
  const targetId = opened?.id ?? tab.id;
  // 새 탭이 앞으로 나오면 사용자는 AI Console(진행 상황과 확인 창)을 놓친다. 되돌린다.
  if (opened && ctx.appTabId !== null) await chrome.tabs.update(ctx.appTabId, { active: true }).catch(() => {});
  await waitForLoad(targetId);
  return afterAction(targetId, ctx, opened ? `${done.message} 새 탭(${targetId})이 열렸습니다.` : done.message);
}

async function scrollCommand(args, ctx) {
  const { tab, error } = await resolveTab(args);
  if (error) return { ok: false, error };
  const gate = await siteGate(tab.url ?? "", ctx);
  if (gate) return gate;
  const direction = ["up", "down", "top", "bottom"].includes(args.direction) ? args.direction : "down";
  await run(tab.id, scrollPage, [direction]);
  await sleep(400);
  return readTab(tab.id, 0, `${direction} 방향으로 스크롤했습니다.`);
}

async function backCommand(args, ctx) {
  const { tab, error } = await resolveTab(args);
  if (error) return { ok: false, error };
  const gate = await siteGate(tab.url ?? "", ctx);
  if (gate) return gate;
  // chrome.tabs.goBack 은 브라우저의 뒤로 단추와 같아서, 사용자의 클릭 없이 스크립트로
  // 넘어간 기록을 건너뛴다(크롬의 기록 조작 방지). 모델의 클릭·제출은 모두 스크립트라
  // 그 기록이 통째로 건너뛰어졌다. 페이지 안의 history.back() 은 그 규칙을 받지 않는다.
  const before = tab.url;
  await run(tab.id, () => {
    history.back();
    return true;
  }, []);
  await sleep(400);
  await waitForLoad(tab.id);
  const after = await chrome.tabs.get(tab.id);
  if (after.url === before) return { ok: false, error: "뒤로 갈 페이지가 없습니다." };
  return afterAction(tab.id, ctx, "뒤로 갔습니다.");
}

function formatSnapshot(tabId, snap, textOffset, note) {
  if (!snap) return `${note}\n페이지를 읽지 못했습니다.`;
  const end = textOffset + snap.text.length;
  const textHead = snap.textTruncated
    ? `본문 ${textOffset}~${end}자 / 전체 ${snap.textLength}자 — 이어 읽으려면 browser_read 의 text_offset=${end}`
    : textOffset > 0
      ? `본문 ${textOffset}~${end}자 (끝)`
      : "본문";
  return [
    note,
    `[탭 ${tabId}] ${snap.title}`,
    `주소: ${snap.url}`,
    `스크롤: ${snap.scrollY} / ${snap.scrollMax} (화면 높이 ${snap.viewport})`,
    `--- ${textHead} ---`,
    snap.text || "(본문 없음)",
    `--- 조작할 수 있는 요소 (browser_click·browser_type 의 ref) ---`,
    snap.elements.length > 0 ? snap.elements.join("\n") : "(없음)",
    snap.elementsTruncated ? `(요소가 많아 앞 ${snap.elements.length}개만 보였습니다. 스크롤하면 바뀝니다.)` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------- 페이지 안에서 도는 함수
// executeScript 로 페이지에 넣어 실행한다. 바깥 변수를 쓸 수 없으므로 각자 완결돼야 한다.

function snapshotPage(maxText, maxElements, textOffset) {
  for (const old of document.querySelectorAll("[data-aic-ref]")) old.removeAttribute("data-aic-ref");
  const selector = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "summary",
    "[contenteditable=''], [contenteditable='true']",
    "[role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=option], [role=switch], [role=combobox], [role=searchbox], [role=textbox]",
  ].join(", ");
  const elements = [];
  let truncated = false;
  let n = 0;
  for (const el of document.querySelectorAll(selector)) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width < 2 || rect.height < 2 || style.visibility === "hidden" || style.display === "none") continue;
    if (el.disabled) continue;
    if (elements.length >= maxElements) {
      truncated = true;
      break;
    }
    const ref = `e${++n}`;
    el.setAttribute("data-aic-ref", ref);
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    let kind = el.getAttribute("role") || tag;
    if (tag === "a") kind = "링크";
    else if (tag === "button" || ["button", "submit", "reset", "image"].includes(type)) kind = "버튼";
    else if (tag === "select") kind = "선택 목록";
    else if (tag === "textarea") kind = "입력칸";
    else if (tag === "input") kind = type === "checkbox" ? "체크박스" : type === "radio" ? "라디오" : `입력칸(${type || "text"})`;
    else if (el.isContentEditable) kind = "편집 영역";
    const name = (
      el.getAttribute("aria-label") ||
      (tag === "input" || tag === "textarea" || tag === "select" ? "" : el.innerText) ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      (tag === "input" && ["button", "submit", "reset"].includes(type) ? el.value : "") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    let line = `[${ref}] ${kind} "${name}"`;
    if (tag === "a") {
      const href = el.getAttribute("href") || "";
      if (!href.startsWith("javascript:") && href !== "#") line += ` → ${el.href.slice(0, 120)}`;
    }
    if ((tag === "input" && !["button", "submit", "reset", "checkbox", "radio", "image"].includes(type)) || tag === "textarea") {
      line += type === "password" ? " (비밀번호 칸 — 입력 불가)" : ` 값="${String(el.value).slice(0, 60)}"`;
    }
    if (type === "checkbox" || type === "radio") line += el.checked ? " (선택됨)" : " (선택 안 됨)";
    if (tag === "select") line += ` 현재="${el.selectedOptions[0]?.text?.trim() ?? ""}"`;
    if (rect.bottom < 0 || rect.top > innerHeight) line += " (화면 밖)";
    elements.push(line);
  }
  const fullText = (document.body?.innerText || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const text = fullText.slice(textOffset, textOffset + maxText);
  const scrollMax = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  return {
    url: location.href,
    title: document.title,
    text,
    textLength: fullText.length,
    textTruncated: textOffset + maxText < fullText.length,
    elements,
    elementsTruncated: truncated,
    scrollY: Math.round(scrollY),
    scrollMax,
    viewport: innerHeight,
  };
}

function inspectElement(ref, riskSource) {
  const el = document.querySelector(`[data-aic-ref="${ref}"]`);
  if (!el) return { found: false };
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title") || el.getAttribute("placeholder") || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  const form = el.form || el.closest("form");
  // GET 폼(검색창 등)의 제출은 되돌릴 일이 없는 조회다. POST 폼이나 폼이 없는 곳(메신저의
  // Enter 전송 같은 것)은 무엇이 일어날지 모르므로 묻는다.
  const postForm = Boolean(form) && (form.getAttribute("method") || "get").toLowerCase() === "post";
  const submitButton =
    (tag === "button" && (type === "submit" || (!type && Boolean(form)))) || (tag === "input" && (type === "submit" || type === "image"));
  return {
    found: true,
    label,
    password: tag === "input" && type === "password",
    risky: (submitButton && postForm) || new RegExp(riskSource, "i").test(label),
    submitRisky: !form || postForm,
  };
}

function clickElement(ref) {
  const el = document.querySelector(`[data-aic-ref="${ref}"]`);
  if (!el) return { ok: false, error: `${ref} 요소가 사라졌습니다. browser_read 로 다시 읽으세요.` };
  el.scrollIntoView({ block: "center", inline: "center" });
  const label = (el.getAttribute("aria-label") || el.innerText || el.value || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const rect = el.getBoundingClientRect();
  const point = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
  // 포인터·마우스 이벤트만 듣는 요소도 있어 순서대로 다 보낸다. click() 이 마지막이다.
  el.dispatchEvent(new PointerEvent("pointerdown", point));
  el.dispatchEvent(new MouseEvent("mousedown", point));
  if (typeof el.focus === "function") el.focus({ preventScroll: true });
  el.dispatchEvent(new PointerEvent("pointerup", point));
  el.dispatchEvent(new MouseEvent("mouseup", point));
  el.click();
  return { ok: true, message: `${ref} "${label}" 을(를) 눌렀습니다.` };
}

function typeIntoElement(ref, text, submit) {
  const el = document.querySelector(`[data-aic-ref="${ref}"]`);
  if (!el) return { ok: false, error: `${ref} 요소가 사라졌습니다. browser_read 로 다시 읽으세요.` };
  el.scrollIntoView({ block: "center" });
  if (typeof el.focus === "function") el.focus({ preventScroll: true });
  const tag = el.tagName.toLowerCase();
  if (tag === "select") {
    const options = [...el.options];
    const wanted = text.trim();
    const option =
      options.find((o) => o.text.trim() === wanted || o.value === wanted) || options.find((o) => o.text.includes(wanted));
    if (!option) {
      return {
        ok: false,
        error: `"${text}" 선택지가 없습니다. 선택지: ${options.map((o) => o.text.trim()).slice(0, 30).join(", ")}`,
      };
    }
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, message: `${ref} 에서 "${option.text.trim()}" 을(를) 골랐습니다.` };
  }
  if (el.isContentEditable) {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
  } else if (tag === "input" || tag === "textarea") {
    // 프레임워크(React 등)가 바뀐 값을 알아차리도록 원래 setter 로 넣고 input 을 보낸다.
    const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    return { ok: false, error: `${ref} 는 글을 넣을 수 있는 요소가 아닙니다.` };
  }
  if (submit) {
    const key = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const notHandled = el.dispatchEvent(new KeyboardEvent("keydown", key));
    el.dispatchEvent(new KeyboardEvent("keypress", key));
    el.dispatchEvent(new KeyboardEvent("keyup", key));
    const form = el.form || el.closest("form");
    if (notHandled && form) {
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
    }
  }
  return { ok: true, message: `${ref} 에 입력했습니다${submit ? "(제출함)" : ""}.` };
}

function scrollPage(direction) {
  if (direction === "top") scrollTo({ top: 0, behavior: "instant" });
  else if (direction === "bottom") scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
  else scrollBy({ top: (direction === "up" ? -1 : 1) * Math.round(innerHeight * 0.8), behavior: "instant" });
  return true;
}
