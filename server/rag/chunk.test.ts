// 청커 테스트. 프레임워크 없이 `npm test` 로 돌리고 하나라도 실패하면
// 종료 코드 1 을 낸다.
//
// 이 파일이 지키는 것은 "청크가 만들어지는가" 가 아니라 "원문을 잃지 않는가"
// 와 "인용할 수 있는 조각인가" 다. 청크가 나오기만 하는 것은 쉽고, 문장
// 중간에서 잘린 조각을 내놓는 것도 똑같이 쉽다.

import { chunkText, _internals } from "./chunk.js";

const { splitSentences } = _internals;

let passed = 0;
const failures: Array<{ name: string; message: string }> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push({ name, message: e instanceof Error ? e.message : String(e) });
    console.log(`FAIL  ${name}`);
    console.log(`      ${e.message}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function eq(actual: unknown, expected: unknown, msg?: string): void {
  if (actual !== expected) {
    throw new Error(`${msg ?? 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** 공백을 모두 뺀 문자열 — "텍스트를 잃지 않았는가" 는 공백 제외로 판정한다. */
const squeeze = (s: string) => s.replace(/\s+/g, "");

// ---------------------------------------------------------------- 테스트 자료

const PARAS = [
  'SF-1 v7.4 는 검색 엔진이다. 색인과 검색을 같은 프로세스에서 처리할 수도 있고, 역할을 나누어 searcher 와 indexer 로 따로 띄울 수도 있다. 역할을 나누면 색인 부하가 검색 응답 시간에 영향을 주지 않는다. 다만 두 프로세스가 같은 data 디렉터리를 보아야 한다.',
  '색인 API 는 POST /index/{컬렉션} 이고 본문은 문서 객체의 배열이다. 응답은 result 와 success, fail, total 을 담는다. 문서가 전부 실패해도 HTTP 200 이 돌아오므로 상태 코드만 보고 성공을 판단하면 안 된다. 반드시 fail 목록을 확인해야 한다.',
  '대량 색인에서는 commit 헤더를 false 로 주어 커밋을 미룬다. 그리고 마지막에 POST /index/{컬렉션}/commit 을 한 번만 부른다. 커밋은 진행 중인 세그먼트 병합을 기다리지 않기 때문에 보통 0.1 초에서 0.2 초 사이에 끝난다.',
  '검색 질의 키는 commonQuery 다. query 라는 키는 삭제 API 가 쓰는 것이라 검색에서는 동작하지 않는다. 여러 단어를 넣으면 AND 로 묶이고, OR 로 묶으려면 막대 기호를 쓴다. 결과가 0 건이면 응답에서 document 키 자체가 빠진다.',
  '벡터 검색은 vectorQuery 배열로 요청한다. 각 원소는 field 와 queryStr, k 를 갖는다. 모델이 지정된 필드여야 하고, 결과 문서의 distance 가 벡터 거리다. 벡터가 아닌 문서의 distance 는 -1.0 으로 온다.',
  '텍스트 필드 값은 정확일치 색인에서 10,922 자에서 잘린다. 그래서 RAG 용 본문은 그보다 훨씬 짧게 쪼개어 넣어야 한다. 청크 하나를 600 자 안팎으로 잡으면 잘림 걱정이 없다.',
];

const KOREAN_DOC = PARAS.join('\n\n');

// -------------------------------------------------------------------- 테스트

console.log('server/rag/chunk.ts');

test('빈 입력과 공백만 있는 입력은 청크를 만들지 않는다', () => {
  eq(chunkText('').length, 0, 'empty');
  eq(chunkText('   \n\n \t \n ').length, 0, 'whitespace only');
  // 타입으로는 막혀 있지만 런타임에는 들어올 수 있는 값 — 던지지 않고 빈 결과여야 한다.
  eq(chunkText(null as unknown as string).length, 0, 'null');
});

test('target 보다 짧은 글은 청크 하나로 남는다', () => {
  const c = chunkText('짧은 문서다. 자를 이유가 없다.');
  eq(c.length, 1);
  eq(c[0].ord, 0);
  eq(c[0].overlapLen, 0);
});

test('한국어 문단 문서는 문단 경계에서 갈린다', () => {
  const chunks = chunkText(KOREAN_DOC);
  assert(chunks.length > 1, `문단 ${PARAS.length}개 문서가 한 청크로 남았다 (${chunks.length})`);

  // 각 청크가 새로 담당하는 본문(= 이월분을 뺀 부분)은 어떤 문단의 첫머리에서 시작해야 한다.
  const heads = PARAS.map((p) => p.slice(0, 20));
  for (const c of chunks) {
    const body = c.text.slice(c.overlapLen);
    assert(
      heads.some((h) => body.startsWith(h)),
      `문단 중간에서 청크가 시작됐다 (ord=${c.ord}): ${JSON.stringify(body.slice(0, 40))}`,
    );
  }
});

test('v7.4 와 3.14 는 문장을 끊지 않는다', () => {
  const s = splitSentences('SF-1 v7.4 는 새 판이다. 원주율은 3.14 이고 버전은 1.2.3 이다. 끝이다.');
  eq(s.length, 3, `문장 수가 틀렸다: ${JSON.stringify(s)}`);
  assert(s[0].includes('v7.4'), 'v7.4 가 쪼개졌다');
  assert(s[1].includes('3.14') && s[1].includes('1.2.3'), '소수/버전이 쪼개졌다');

  // 청킹 단계에서도 같은 토큰이 두 청크로 갈라지지 않는지 본다.
  const long = 'SF-1 v7.4 는 검색 엔진이다. '.repeat(60);
  for (const c of chunkText(long)) {
    assert(!/v7\.$/.test(c.text.trim()), 'v7.4 가 청크 경계에서 잘렸다');
    assert(!/^4\s/.test(c.text.slice(c.overlapLen)), 'v7.4 가 청크 경계에서 잘렸다');
  }
});

test('파일명·URL 의 마침표는 문장을 끊지 않는다', () => {
  const s = splitSentences('설정은 config/indexer.json 에 있다. 엔진은 http://localhost:9400 에서 돈다.');
  eq(s.length, 2, JSON.stringify(s));
  assert(s[0].includes('indexer.json'), 'indexer.json 이 쪼개졌다');
  assert(s[1].includes('localhost:9400'), 'URL 이 쪼개졌다');
});

test('줄임표와 영문 약어는 문장을 끊지 않는다', () => {
  eq(splitSentences('생각해 보면... 답은 하나다.').length, 1, '줄임표에서 끊겼다');
  eq(splitSentences('여러 옵션 e.g. commit 헤더를 쓴다.').length, 1, 'e.g. 에서 끊겼다');
  eq(splitSentences('Mr. Kim 이 확인했다.').length, 1, 'Mr. 에서 끊겼다');
  eq(splitSentences('etc. 로 끝나는 목록이다.').length, 1, 'etc. 에서 끊겼다');
  eq(splitSentences('J. R. R. 이 쓴 책이다.').length, 1, '이니셜에서 끊겼다');
});

test('한국어 종결어미에서는 문장을 끊는다', () => {
  eq(splitSentences('색인을 마쳤다. 검색이 됩니다. 언제 끝날까? 정말!').length, 4);
  // 마침표 뒤 공백이 없는 흔한 오타도 끊는다.
  eq(splitSentences('색인을 마쳤다.그리고 검색했다.').length, 2, '공백 없는 마침표에서 못 끊었다');
});

test('끊기지 않는 5,000자 문단도 쪼개지고 target+overlap 을 넘지 않는다', () => {
  const para = '색인배치단위와커밋시점을함께보아야한다 '.repeat(260).trim();
  assert(para.length >= 5000, `자료가 5,000자에 못 미친다 (${para.length})`);

  const chunks = chunkText(para, { targetChars: 600, overlapChars: 80 });
  assert(chunks.length >= 8, `쪼개지지 않았다 (${chunks.length} 청크)`);
  for (const c of chunks) {
    assert(c.text.length <= 600 + 80, `청크 ${c.ord} 가 ${c.text.length}자로 한도(680)를 넘었다`);
  }
});

test('빈 청크가 없고 ord 는 0 부터 연속이다', () => {
  for (const input of [KOREAN_DOC, PARAS[0], '가'.repeat(5000), KOREAN_DOC + '\n\n\n\n' + PARAS[1]]) {
    const chunks = chunkText(input);
    chunks.forEach((c, i) => {
      assert(c.text.trim().length > 0, '공백뿐인 청크가 나왔다');
      eq(c.ord, i, 'ord 가 연속이 아니다');
    });
  }
});

test('이월분을 빼고 이으면 원문의 비공백 문자가 그대로 복원된다', () => {
  const cases = [
    KOREAN_DOC,
    '가'.repeat(5000),
    '한 줄짜리 문서.',
    'A\n\nB\n\n\n\nC',
    PARAS.join('\r\n\r\n'), // CRLF 도 같은 결과여야 한다
    '  앞뒤 공백이 있는 문서다.  ',
  ];
  for (const input of cases) {
    const chunks = chunkText(input);
    const rebuilt = chunks.map((c) => c.text.slice(c.overlapLen)).join('');
    eq(squeeze(rebuilt), squeeze(input), `원문이 손실됐다 (${JSON.stringify(input.slice(0, 25))}…)`);
  }
});

test('이월분은 실제로 다음 청크 머리에 나타난다', () => {
  const chunks = chunkText(KOREAN_DOC, { targetChars: 600, overlapChars: 80 });
  assert(chunks.length > 1, '겹침을 볼 청크가 부족하다');
  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i];
    assert(c.overlapLen > 0, `청크 ${i} 에 이월분이 없다`);
    const carried = c.text.slice(0, c.overlapLen - 1); // 끝 한 글자는 구분자다
    assert(carried.length > 0, `청크 ${i} 의 이월분이 비어 있다`);
    assert(carried.length <= 80, `청크 ${i} 의 이월분이 overlapChars 를 넘었다 (${carried.length})`);
    const prevBody = chunks[i - 1].text.slice(chunks[i - 1].overlapLen);
    assert(prevBody.endsWith(carried), `청크 ${i} 의 이월분이 앞 청크의 꼬리가 아니다`);
  }
});

test('옵션이 잘못되면 조용히 넘어가지 않고 던진다', () => {
  for (const bad of [{ targetChars: 0 }, { overlapChars: -1 }, { targetChars: 100, overlapChars: 100 }]) {
    let threw = false;
    try {
      chunkText('아무 글', bad);
    } catch {
      threw = true;
    }
    assert(threw, `${JSON.stringify(bad)} 가 통과했다`);
  }
});

// ---------------------------------------------------------------------- 결과

console.log('');
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
