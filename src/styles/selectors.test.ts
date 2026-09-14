// 선택자가 실제로 있는 것을 가리키는지 검사. `npm test` 로 돈다.
//
// App.css 는 자기 것이 아닌 클래스를 가리킨다. 좁은 화면에서 여백을 걷고
// 팝오버 폭을 묶는 규칙이 여섯 페이지의 CSS 에 흩어진 이름들을 부르기
// 때문이다. 기준을 한 곳에 모으려면 그 수밖에 없는데, 대신 **이름이 틀려도
// 아무 일도 일어나지 않는다** — 빌드도 통과하고 오류도 없고, 그저 좁은
// 화면에서 여백이 안 줄어들 뿐이다. 실제로 이 파일을 쓰기 직전에 팝오버
// 네 개를 전부 `-menu` 로 잘못 불러 두었고, 빌드는 멀쩡히 통과했다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const componentsDir = path.join(here, "..", "components");

/**
 * 주석을 걷어낸 뒤에 본다. 이 저장소의 CSS 주석에는 `index.html` 이나
 * `.env` 같은 말이 자주 나오는데, 걷지 않으면 그것들이 클래스 이름으로
 * 잡혀 있지도 않은 실패를 만든다 (실제로 처음 이 검사가 그랬다).
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const appCss = stripComments(fs.readFileSync(path.join(here, "..", "App.css"), "utf8"));

// 모든 컴포넌트 CSS 에 정의된 클래스 이름을 모은다.
const defined = new Set<string>();
for (const file of fs.readdirSync(componentsDir)) {
  if (!file.endsWith(".css")) continue;
  const text = stripComments(fs.readFileSync(path.join(componentsDir, file), "utf8"));
  for (const m of text.matchAll(/\.([a-zA-Z][\w-]*)/g)) defined.add(m[1]!);
}
// App.css 자신이 정의하는 것도 제자리에 있는 것으로 친다.
for (const m of appCss.matchAll(/^\s*\.([a-zA-Z][\w-]*)/gm)) defined.add(m[1]!);

let passed = 0;
const failures: Array<{ name: string; message: string }> = [];

function check(name: string, condition: unknown, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push({ name, message: detail });
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("src/App.css — 남의 클래스를 부르는 선택자");

// App.css 가 부르는 클래스 가운데, 스스로 정의하지 않은 것들.
const referenced = new Set<string>();
for (const m of appCss.matchAll(/\.([a-zA-Z][\w-]*)/g)) referenced.add(m[1]!);

for (const name of [...referenced].sort()) {
  check(`.${name} 는 어딘가에 정의되어 있다`, defined.has(name), "App.css 만 알고 아무도 정의하지 않음");
}

// 좁은 화면 규칙이 실제로 노리는 것들은 빠짐없이 들어 있어야 한다.
for (const must of [
  "chat-header",
  "board-header",
  "documents-header",
  "library-header",
  "admin-header",
  "mcp-picker-popover",
  "reasoning-popover",
  "model-switcher-popover",
  "sidebar-settings-popover",
]) {
  check(`좁은 화면 규칙이 .${must} 를 부른다`, referenced.has(must), "App.css 에서 빠졌다");
}

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  throw new Error(`${failures.length}건 실패`);
}
