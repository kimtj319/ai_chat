// AI Console 페이지 ↔ 확장 프로그램 중계. 사용자가 팝업에 적은 AI Console 주소의
// 페이지에만 들어간다(background.js 가 그 주소로만 등록한다). 그래도 한 번 더
// 확인한다 — 다른 사이트가 이 중계를 통해 브라우저를 조작하게 두면 안 된다.
(() => {
  if (window.__aicBridgeInstalled) return;
  window.__aicBridgeInstalled = true;

  const VERSION = chrome.runtime.getManifest().version;

  chrome.storage.local.get(["appOrigin"]).then(({ appOrigin }) => {
    if (!appOrigin || location.origin !== appOrigin) return;

    const post = (message) => window.postMessage({ source: "aic-ext", ...message }, location.origin);
    const hello = () =>
      chrome.storage.local
        .get(["enabled"])
        .then(({ enabled }) => post({ type: "hello", version: VERSION, enabled: enabled !== false }));

    window.addEventListener("message", (event) => {
      // 이 페이지 자신이 보낸 것만 받는다.
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data;
      if (!data || data.source !== "aic-page") return;
      if (data.type === "ping") {
        hello();
        return;
      }
      if (data.type === "command" && typeof data.requestId === "string") {
        chrome.runtime
          .sendMessage({ kind: "command", command: data.command })
          .then(
            (response) => post({ type: "result", requestId: data.requestId, response }),
            (err) =>
              post({
                type: "result",
                requestId: data.requestId,
                response: { ok: false, error: `확장 프로그램 오류: ${err?.message ?? err}` },
              }),
          );
      }
    });

    // 확장의 예약 알람이 깨운다 — 페이지가 예약 목록을 다시 받고 타이머를 새로 건다.
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.kind === "wake") post({ type: "wake" });
    });

    chrome.storage.onChanged.addListener((changes) => {
      if (changes.enabled) hello();
    });
    hello();
  });
})();
