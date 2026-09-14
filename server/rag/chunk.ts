/**
 * RAG 청커 — 구조(문단) 우선, 문장 차선, 문자 단위 절단은 최후 수단.
 *
 * 왜 이 순서인가: LLM 이 인용할 수 있는 passage 를 만드는 것이 목적이므로,
 * 문장 중간에서 잘린 조각은 검색에 걸려도 쓸모가 없다. 그래서 자를 자리를
 * "문단 경계 → 문장 경계 → (어쩔 수 없을 때만) 문자 위치" 로 내려가며 고른다.
 */

// 문장 끝 뒤에 따라올 수 있는 닫는 부호. `"...했다."` 처럼 마침표 뒤에 인용부호가
// 오면 경계는 인용부호 **뒤**다.
const CLOSERS = `"'”’」』›»)]}>`;

// 마침표로 끝나지만 문장 끝이 아닌 영문 약어. 뒤에 공백이 오기 때문에
// "마침표 + 공백 = 문장 끝" 규칙만으로는 걸러지지 않아 목록이 필요하다.
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "st", "jr", "sr",
  "etc", "eg", "ie", "cf", "vs", "al", "approx", "est",
  "inc", "ltd", "co", "corp", "dept", "univ",
  "fig", "no", "vol", "pp", "ed", "ca",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

const TERMINATORS = ".?!。？！";
const HANGUL = /[가-힣]/;
const DIGIT = /[0-9]/;

export const DEFAULT_TARGET_CHARS = 600;
export const DEFAULT_OVERLAP_CHARS = 80;

export interface Chunk {
  text: string;
  ord: number;
  /**
   * text 앞쪽에서 직전 청크로부터 이월된 문자 수. `text.slice(overlapLen)` 이
   * 이 청크가 새로 담당하는 부분이라, 이 값으로 중복을 빼고 원문 복원 여부를
   * 검증할 수 있다.
   */
  overlapLen: number;
}

export interface ChunkOptions {
  targetChars?: number;
  overlapChars?: number;
}

/**
 * text[i] 가 진짜 문장 끝인지 판정한다.
 *
 * 이 함수가 이 파일에서 가장 틀리기 쉬운 곳이다. 한국어 문장은 `다.` `요.` `까?`
 * 로 끝나지만, 마침표는 소수점(`3.14`)·버전(`v7.4`)·파일명(`config.json`)·
 * 줄임표(`...`)·영문 약어(`e.g.`)에도 쓰인다. 아래 규칙은 그 다섯 가지를 전부
 * 문장 끝이 아닌 것으로 판정한다.
 */
function isSentenceEnd(text: string, i: number): boolean {
  const ch = text[i];

  // 줄임표 문자 자체는 문장을 끊지 않는다 — `…` 뒤에 실제 종결부호가 오는 것이 보통이다.
  if (ch === "…") return false;

  if (ch === ".") {
    // 점이 연속하면(`..` `...`) 그 줄임표 전체가 경계가 아니다.
    // 앞뒤 어느 쪽으로든 점이 붙어 있으면 런의 일부이므로 끊지 않는다.
    if (text[i + 1] === "." || text[i - 1] === ".") return false;

    // 소수점·버전 번호: 숫자.숫자 (`3.14`, `v7.4`, `1.2.3`)
    if (DIGIT.test(text[i - 1] ?? "") && DIGIT.test(text[i + 1] ?? "")) return false;

    // 영문 약어와 이니셜. 마침표 바로 앞의 라틴 낱말만 본다.
    const word = /([A-Za-z]+)$/.exec(text.slice(Math.max(0, i - 12), i));
    if (word) {
      const w = word[1].toLowerCase();
      // 한 글자 라틴 + 마침표는 이니셜(`J. R. R.`)이거나 `e.g.` 의 조각이다.
      if (w.length === 1) return false;
      if (ABBREVIATIONS.has(w)) return false;
    }

    // 한국어 본문은 `…했다.그리고` 처럼 마침표 뒤 공백을 빠뜨리는 일이 잦다.
    // 마침표 바로 뒤가 한글이면 약어일 수가 없으므로 문장 끝으로 본다.
    if (HANGUL.test(text[i + 1] ?? "")) return true;
  }

  // 공통 규칙: 닫는 부호를 건너뛴 다음이 공백이거나 글 끝이어야 문장 끝이다.
  // 이 한 줄이 `config.json` · `localhost:9400` 같은 붙어 있는 마침표를 전부 막는다.
  let j = i + 1;
  while (j < text.length && CLOSERS.includes(text[j])) j++;
  if (j >= text.length) return true;
  return /\s/.test(text[j]);
}

/** 한 문단을 문장 배열로 나눈다. 문장 안의 공백은 원문 그대로 두고 양 끝만 다듬는다. */
function splitSentences(block: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < block.length; i++) {
    if (!TERMINATORS.includes(block[i])) continue;
    if (!isSentenceEnd(block, i)) continue;

    let j = i + 1;
    while (j < block.length && CLOSERS.includes(block[j])) j++;

    const s = block.slice(start, j).trim();
    if (s) out.push(s);
    start = j;
    i = j - 1;
  }
  const tail = block.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * 문장 하나가 target 을 넘을 때의 최후 수단. 그냥 자르면 낱말이 쪼개지므로
 * 창의 뒤쪽 15% 안에 공백이 있으면 거기서 끊는다. 앞당겨 자르는 것이라
 * 결과 조각이 target 을 넘는 일은 없다.
 */
function hardCut(s: string, target: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > target) {
    let cut = target;
    const from = Math.floor(target * 0.85);
    const ws = rest.slice(from, target).lastIndexOf(" ");
    if (ws >= 0) cut = from + ws;
    if (cut <= 0) cut = target; // target 이 아주 작을 때 진행이 멈추지 않도록
    const piece = rest.slice(0, cut).trim();
    if (piece) out.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * 직전 청크의 꼬리를 다음 청크 머리에 붙일 조각으로 뽑는다.
 * 낱말 중간에서 시작하지 않도록 첫 공백 뒤로 당긴다 — 그래서 실제 길이는
 * n 보다 짧을 수 있다.
 */
function tailOverlap(s: string, n: number): string {
  if (n <= 0 || !s) return "";
  let t = s.slice(Math.max(0, s.length - n));
  const sp = t.search(/\s/);
  if (sp >= 0) t = t.slice(sp + 1);
  return t.trim();
}

/** 줄바꿈을 통일한 원문. 어느 경로로 자르든 같은 글자를 보게 하려고 한 곳에 둔다. */
export function normalize(text: string): string {
  return String(text ?? "").replace(/\r\n?/g, "\n");
}

/**
 * 1·2단계 — 자를 수 있는 최소 단위를 만들고 target 까지 채운다.
 *
 * LLM 경계 청킹(llmChunk.ts)도 이 단계의 결과물과 같은 모양(겹침이 붙기 전의
 * 본문 배열)을 만들어 낸 다음 {@link applyOverlap} 으로 넘긴다. 그래서 겹침
 * 규칙은 이 파일에만 있고, 청킹 방식이 둘이어도 하나로 유지된다.
 */
export function buildBodies(text: string, targetChars: number = DEFAULT_TARGET_CHARS): string[] {
  if (targetChars <= 0) throw new Error("targetChars 는 1 이상이어야 한다");
  const norm = normalize(text);

  // 1단계: 자를 수 있는 최소 단위(unit)를 만든다.
  //   문단이 target 안에 들어가면 문단 통째가 한 unit 이고,
  //   넘치면 문장으로, 문장도 넘치면 문자 단위로 내려간다.
  //   unit 은 모두 target 이하라, 뒤의 채우기 단계가 target 을 넘지 않는다.
  // unit 은 어느 문단에서 왔는지(para)를 달고 다닌다 — 이어 붙일 때 문단 사이는
  // 빈 줄로, 한 문단 안의 문장 사이는 공백으로 되살리기 위해서다.
  const units: Array<{ text: string; para: number }> = [];
  let para = 0;
  for (const block of norm.split(/\n[ \t]*\n+/)) {
    const b = block.trim();
    if (!b) continue;
    para++;
    if (b.length <= targetChars) {
      units.push({ text: b, para });
      continue;
    }
    for (const sent of splitSentences(b)) {
      const pieces = sent.length <= targetChars ? [sent] : hardCut(sent, targetChars);
      for (const p of pieces) units.push({ text: p, para });
    }
  }

  // 2단계: unit 을 target 까지 욕심껏 채운다. 청크 경계는 언제나 unit 경계이므로
  //   곧 문단 경계이거나 문장 경계다(hardCut 이 걸린 문단만 예외).
  const bodies: string[] = [];
  let cur = "";
  let curPara = -1;
  for (const u of units) {
    const sep = cur === "" ? "" : u.para === curPara ? " " : "\n\n";
    if (cur && cur.length + sep.length + u.text.length > targetChars) {
      bodies.push(cur);
      cur = u.text;
    } else {
      cur = cur + sep + u.text;
    }
    curPara = u.para;
  }
  if (cur) bodies.push(cur);

  return bodies;
}

/**
 * 3단계 — 앞 청크의 꼬리를 겹쳐 붙인다. 경계에 걸쳐 있는 사실이 어느 한쪽
 * 청크만으로도 읽히게 하려는 것이다.
 *
 * 꼬리를 overlapChars-1 로 자르는 이유: 뒤에 구분자 한 글자를 더 붙이므로
 * 이월분 전체가 정확히 overlapChars 이하가 되어 청크는 target+overlap 을 넘지 않는다.
 */
export function applyOverlap(bodies: string[], overlapChars: number = DEFAULT_OVERLAP_CHARS): Chunk[] {
  if (overlapChars < 0) throw new Error("overlapChars 는 0 이상이어야 한다");
  const chunks: Chunk[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const ov = i === 0 ? "" : tailOverlap(bodies[i - 1], overlapChars - 1);
    const text = ov ? `${ov}\n${bodies[i]}` : bodies[i];
    if (!text.trim()) continue; // 방어적 — 본문 단계에서 빈 것은 이미 걸러진다
    chunks.push({ text, ord: chunks.length, overlapLen: ov ? ov.length + 1 : 0 });
  }
  return chunks;
}

/** 텍스트를 검색용 청크로 나눈다. 규칙 기반 경로의 입구. */
export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const targetChars = opts.targetChars ?? DEFAULT_TARGET_CHARS;
  const overlapChars = opts.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  if (overlapChars >= targetChars) throw new Error("overlapChars 는 targetChars 보다 작아야 한다");
  return applyOverlap(buildBodies(text, targetChars), overlapChars);
}

export const _internals = { splitSentences, isSentenceEnd, hardCut, tailOverlap };
