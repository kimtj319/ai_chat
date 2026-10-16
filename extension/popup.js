const $ = (id) => document.getElementById(id);

function setStatus(text, tone) {
  $("status").textContent = text;
  if (tone) $("status").dataset.tone = tone;
  else delete $("status").dataset.tone;
}

async function render() {
  const { appOrigin, enabled, allowedSites } = await chrome.storage.local.get(["appOrigin", "enabled", "allowedSites"]);
  $("app-origin").value = appOrigin ?? "";
  $("enabled").checked = enabled !== false;
  const sites = Array.isArray(allowedSites) ? allowedSites : [];
  const list = $("sites");
  list.textContent = "";
  if (sites.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "아직 없습니다. 모델이 처음 가는 사이트는 AI Console 화면에서 허용을 묻습니다.";
    list.append(empty);
  }
  for (const site of sites) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = site;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "link";
    remove.textContent = "삭제";
    remove.addEventListener("click", async () => {
      await chrome.storage.local.set({ allowedSites: sites.filter((s) => s !== site) });
      void render();
    });
    item.append(name, remove);
    list.append(item);
  }
  if (appOrigin && !$("status").textContent) setStatus(`${appOrigin} 의 AI Console 탭과 연결됩니다.`);
}

$("save").addEventListener("click", async () => {
  const raw = $("app-origin").value.trim();
  let origin;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    origin = url.origin;
  } catch {
    setStatus("http:// 또는 https:// 로 시작하는 주소를 넣어 주세요.", "error");
    return;
  }
  await chrome.storage.local.set({ appOrigin: origin });
  const response = await chrome.runtime.sendMessage({ kind: "settings-changed" });
  if (response?.ok) setStatus(`저장했습니다. ${origin} 의 AI Console 탭과 연결됩니다.`);
  else setStatus(`연결을 등록하지 못했습니다: ${response?.error ?? "알 수 없는 오류"}`, "error");
  void render();
});

$("enabled").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ enabled: event.target.checked });
  setStatus(event.target.checked ? "크롬 연결을 켰습니다." : "크롬 연결을 껐습니다. 모델의 명령을 모두 거절합니다.");
});

$("clear").addEventListener("click", async () => {
  await chrome.storage.local.set({ allowedSites: [] });
  setStatus("허용한 사이트를 모두 지웠습니다.");
  void render();
});

void render();
