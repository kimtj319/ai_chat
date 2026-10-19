// 문의 게시판 표시 함수 검사. `npm test` 로 돈다.
import { hueOf, initialOf, linkParts, participantsOf, relativeTime, timelineOf } from "./boardFormat";
import type { BoardPostView } from "../api/types";

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: unknown, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("src/state/boardFormat.ts");

const now = Date.parse("2026-10-17T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
check("1분 안은 방금", relativeTime(ago(30_000), now) === "방금");
check("분 단위", relativeTime(ago(5 * 60_000), now) === "5분 전", relativeTime(ago(5 * 60_000), now));
check("시간 단위", relativeTime(ago(3 * 3600_000), now) === "3시간 전");
check("일 단위", relativeTime(ago(2 * 86400_000), now) === "2일 전");
check("한 달 넘으면 날짜", /2026/.test(relativeTime(ago(40 * 86400_000), now)), relativeTime(ago(40 * 86400_000), now));
check("미래 시각(시계 차이)도 방금", relativeTime(new Date(now + 5000).toISOString(), now) === "방금");
check("깨진 값은 빈 글자", relativeTime("nope", now) === "");

check("같은 라벨은 같은 색", hueOf("검색") === hueOf("검색"));
check("색은 0~359", [..."abcdefghij"].every((c) => hueOf(c) >= 0 && hueOf(c) < 360));
check("아바타 글자: 이름 첫 글자", initialOf("김태진", "kimtj319") === "김");
check("이름이 없으면 아이디 첫 글자(대문자)", initialOf(null, "kimtj319") === "K");

const post: BoardPostView = {
  id: "post_1",
  number: 3,
  title: "t",
  body: "",
  tags: [],
  status: "closed",
  authorId: "alice",
  authorName: "앨리스",
  replies: [
    { id: "r1", authorId: "bob", authorName: "밥", body: "a", createdAt: "2026-10-17T01:00:00Z", canEdit: false },
    { id: "r2", authorId: "alice", authorName: "앨리스", body: "b", createdAt: "2026-10-17T03:00:00Z", canEdit: true },
  ],
  createdAt: "2026-10-17T00:00:00Z",
  updatedAt: "2026-10-17T03:00:00Z",
  closedBy: "alice",
  closedAt: "2026-10-17T03:00:00Z",
  canManage: true,
};
const tl = timelineOf(post);
check("활동은 시간 순", tl.map((i) => i.kind).join() === "reply,reply,closed", tl.map((i) => i.kind).join());
check("같은 시각이면 답변이 닫음보다 먼저", tl[1]!.kind === "reply" && tl[2]!.kind === "closed");
check("열린 글에는 닫음 기록이 없다", timelineOf({ ...post, status: "open" }).every((i) => i.kind === "reply"));
const people = participantsOf(post);
check("참여자는 글쓴이 먼저, 한 번씩", people.map((p) => p.id).join() === "alice,bob", people.map((p) => p.id).join());

// 일반 글 속 주소만 링크로. 나머지는 손대지 않는다 — 글자 하나도 바뀌면 안 된다.
const show = (text: string) => linkParts(text).map((p) => (p.url ? `[${p.text}]` : p.text)).join("");
check("주소가 없으면 한 조각", linkParts("그냥 글\n둘째 줄").length === 1 && !linkParts("그냥 글").some((p) => p.url));
check("빈 글은 조각 없음", linkParts("").length === 0);
check("http·https 주소를 찾는다", show("보세요 https://a.example.com/x?y=1 그리고 http://b.example.com") === "보세요 [https://a.example.com/x?y=1] 그리고 [http://b.example.com]", show("보세요 https://a.example.com/x?y=1 그리고 http://b.example.com"));
check("문장 끝 마침표·쉼표는 주소가 아니다", show("링크: https://a.example.com/x. 다음, https://b.example.com,") === "링크: [https://a.example.com/x]. 다음, [https://b.example.com],", show("링크: https://a.example.com/x. 다음, https://b.example.com,"));
check("괄호로 감싼 주소의 닫는 괄호는 뺀다", show("(https://a.example.com/x)") === "([https://a.example.com/x])", show("(https://a.example.com/x)"));
check("주소 안의 짝 맞는 괄호는 남긴다", show("https://en.wikipedia.org/wiki/Foo_(bar) 참고") === "[https://en.wikipedia.org/wiki/Foo_(bar)] 참고", show("https://en.wikipedia.org/wiki/Foo_(bar) 참고"));
check("마크다운 링크 문법은 그대로 보이고 주소만 링크", show("[문서](https://a.example.com/d)") === "[문서]([https://a.example.com/d])", show("[문서](https://a.example.com/d)"));
check("javascript: 는 링크가 아니다", !linkParts("javascript:alert(1)").some((p) => p.url));
check("꺾쇠·따옴표에서 멈춘다", show('<https://a.example.com/x>"') === '<[https://a.example.com/x]>"', show('<https://a.example.com/x>"'));
check("조각을 이으면 원문", linkParts("a https://x.example.com/(y)). b\n https://z.example.com").map((p) => p.text).join("") === "a https://x.example.com/(y)). b\n https://z.example.com");
check("스킴만 있는 것은 링크가 아니다", !linkParts("https:// 뒤가 비었다").some((p) => p.url));

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
