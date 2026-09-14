// 주소 해석 검사. `npm test` 로 돈다.
//
// 프런트에서 처음 붙는 검사인데, 하필 여기인 이유가 있다. 이 규칙이 틀리면
// **주소창에는 글이 찍혀 있는데 화면은 채팅으로 떨어진다**. 오류도 없고 로그도
// 없다. 글을 읽다 새로고침한 사람, 링크를 받아 연 사람만 조용히 엉뚱한 데로
// 간다. 그리고 규칙이 App 과 게시판 두 곳에 나뉘어 있던 동안은 한쪽만 고쳐도
// 빌드가 통과했다.
import {
  BOARD_HASH,
  DOCUMENTS_HASH,
  HASHES,
  boardPostHash,
  boardPostIdFromHash,
  viewFromHash,
} from "./routes.js";

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

console.log("src/routes.ts");

/* ------------------------------------------------------- 화면 고르기 */

{
  check("빈 해시는 채팅", viewFromHash("") === "chat", viewFromHash(""));
  check("#/ 는 채팅", viewFromHash("#/") === "chat", viewFromHash("#/"));
  check("모르는 해시는 채팅으로 떨어진다", viewFromHash("#/없는화면") === "chat", viewFromHash("#/없는화면"));
  for (const [view, hash] of Object.entries(HASHES)) {
    check(`${hash} → ${view}`, viewFromHash(hash) === view, viewFromHash(hash));
  }
}
{
  // 이 줄이 이 파일의 존재 이유다. 글 주소가 게시판으로 가지 않으면 새로고침이
  // 사람을 채팅으로 내던진다.
  check("글 주소도 게시판이다", viewFromHash("#/board/post_abc123") === "board", viewFromHash("#/board/post_abc123"));
  check("한글 id 가 실려도 게시판", viewFromHash("#/board/%EA%B8%80") === "board");
  check("슬래시로 끝나도 게시판", viewFromHash(`${BOARD_HASH}/`) === "board");

  // 접두만 같은 남의 주소를 게시판으로 빨아들이면 안 된다.
  check("이름이 비슷한 다른 화면은 게시판이 아니다", viewFromHash("#/boardroom") === "chat", viewFromHash("#/boardroom"));
  check("다른 화면은 하위 주소를 갖지 않는다", viewFromHash(`${DOCUMENTS_HASH}/x`) === "chat", viewFromHash(`${DOCUMENTS_HASH}/x`));
}

/* ------------------------------------------------------- 글 id 오가기 */

{
  check("목록 주소에는 글이 없다", boardPostIdFromHash(BOARD_HASH) === null);
  check("다른 화면에도 글이 없다", boardPostIdFromHash(DOCUMENTS_HASH) === null);
  check("빈 해시에도 글이 없다", boardPostIdFromHash("") === null);
  check("슬래시만 있으면 글이 아니다", boardPostIdFromHash(`${BOARD_HASH}/`) === null, String(boardPostIdFromHash(`${BOARD_HASH}/`)));

  check("글 id 를 읽는다", boardPostIdFromHash("#/board/post_abc123") === "post_abc123", String(boardPostIdFromHash("#/board/post_abc123")));

  // 넣은 것이 그대로 나와야 한다 — 이 둘이 어긋나면 링크가 열리지 않는다.
  for (const id of ["post_abc123", "글 하나", "a/b", "100%", "?#&=", "한글+영문 mixed"]) {
    check(`넣은 id 가 그대로 나온다: ${id}`, boardPostIdFromHash(boardPostHash(id)) === id, boardPostHash(id));
  }

  // 주소창에서 손으로 고치다 이렇게 되는데, 여기서 예외가 나가면 게시판이
  // 통째로 안 열린다.
  let threw = false;
  let recovered: string | null = null;
  try {
    recovered = boardPostIdFromHash("#/board/%");
  } catch {
    threw = true;
  }
  check("깨진 % 이스케이프에도 터지지 않는다", !threw, "예외가 나갔다");
  check("  그리고 뭔가를 돌려준다 — 없는 글로 안내하면 된다", recovered === "%", String(recovered));
}

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  // 서버 검사들과 달리 process.exit 를 쓰지 않는다. 이 파일은 프런트 소스라
  // 브라우저용 타입 체크도 함께 받는데, 거기에는 node 의 process 가 없다.
  // 던지면 tsx 가 0 이 아닌 코드로 끝나므로 npm test 의 && 사슬은 똑같이 멈춘다.
  throw new Error(`${failures.length}건 실패`);
}
