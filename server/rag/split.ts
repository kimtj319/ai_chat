/**
 * 한도를 넘는 문서를 여러 부분으로 나눈다.
 *
 * 왜 나누는가: 한도의 이유는 색인이 동기라는 것이고, 그건 문서 하나에 대한
 * 제약이지 사람이 가진 자료에 대한 제약이 아니다. 3.2MB PDF 에서 44만 자가
 * 나오는 일은 흔한데, 그걸 사용자가 직접 쪼개려면 PDF 편집기를 열어야 한다 —
 * 쪼개는 일은 우리가 이미 할 줄 안다.
 *
 * 어디서 나누는가: 제목 줄을 최우선으로 본다. 문서의 장 경계가 곧 의미의
 * 경계이고, 나뉜 각 부분이 그 자체로 읽히려면 장 중간에서 끊으면 안 된다.
 * 제목이 없으면 빈 줄(문단), 그마저 없으면 줄에서 끊는다. 어느 경우든
 * **글자는 하나도 잃지 않는다** — 이어 붙이면 원문이다.
 */

/** 마크다운 제목, 그리고 한국어 문서가 흔히 쓰는 번호 표제. */
const HEADING = /^(?:#{1,6}\s+\S|제\s*\d+\s*[장절조]|\d+(?:\.\d+)*\.?\s+\S)/;

export interface DocumentPart {
  text: string;
  /** 1부터. 이름에 `(1/3)` 으로 붙는다. */
  index: number;
  total: number;
}

/**
 * `maxBytes` 를 넘지 않는 조각들로 나눈다. 한도 안이면 나누지 않고 그대로 한 개다.
 *
 * 바이트로 재는 이유는 한도가 바이트이기 때문이다. 한국어는 글자당 3바이트라
 * 글자 수로 재면 한도를 세 배 넘길 수 있다.
 */
export function splitForIndexing(text: string, maxBytes: number): DocumentPart[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return [{ text, index: 1, total: 1 }];
  }

  const lines = text.split("\n");
  const parts: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  /** 이번 조각에서 마지막으로 본 제목 줄의 위치. 넘칠 때 여기로 되감는다. */
  let lastHeadingAt = -1;
  let lastBlankAt = -1;

  const flush = (upto: number) => {
    // upto 는 이번 조각에 들어가지 않을 첫 줄. 나머지는 다음 조각의 앞머리가 된다.
    const keep = current.slice(0, upto);
    const carry = current.slice(upto);
    const body = keep.join("\n");
    if (body.trim()) parts.push(body);
    current = carry;
    currentBytes = Buffer.byteLength(carry.join("\n"), "utf8");
    lastHeadingAt = -1;
    lastBlankAt = -1;
    // 되감은 구간 안에도 경계가 있을 수 있다. 다시 찾아 둔다.
    for (let i = 0; i < carry.length; i++) {
      if (HEADING.test(carry[i])) lastHeadingAt = i;
      else if (carry[i].trim() === "") lastBlankAt = i;
    }
  };

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;

    if (currentBytes + lineBytes > maxBytes && current.length > 0) {
      // 넘쳤다. 가장 좋은 경계로 되감는다: 제목 → 빈 줄 → 줄.
      //
      // 되감을 자리가 조각의 맨 앞이면(경계가 하나뿐이면) 되감아 봐야 빈
      // 조각만 나오므로, 그때는 그냥 여기서 끊는다.
      let cut = current.length;
      if (lastHeadingAt > 0) cut = lastHeadingAt;
      else if (lastBlankAt > 0) cut = lastBlankAt;
      flush(cut);
      currentBytes = Buffer.byteLength(current.join("\n"), "utf8");
    }

    if (HEADING.test(line)) lastHeadingAt = current.length;
    else if (line.trim() === "") lastBlankAt = current.length;
    current.push(line);
    currentBytes += lineBytes;

    // 한 줄이 통째로 한도를 넘는 경우(줄바꿈 없는 거대한 글). 글자 단위로 자른다.
    if (currentBytes > maxBytes && current.length === 1) {
      const only = current[0];
      let rest = only;
      while (Buffer.byteLength(rest, "utf8") > maxBytes) {
        // 바이트 한도를 글자 수로 어림잡고(한국어 3바이트) 넘치면 줄인다.
        let take = Math.floor(maxBytes / 3);
        while (take > 1 && Buffer.byteLength(rest.slice(0, take), "utf8") > maxBytes) take = Math.floor(take * 0.9);
        parts.push(rest.slice(0, take));
        rest = rest.slice(take);
      }
      current = rest ? [rest] : [];
      currentBytes = Buffer.byteLength(rest, "utf8");
      lastHeadingAt = -1;
      lastBlankAt = -1;
    }
  }

  const tail = current.join("\n");
  if (tail.trim()) parts.push(tail);

  const total = parts.length;
  return parts.map((t, i) => ({ text: t, index: i + 1, total }));
}

/** `보고서.pdf` + (2/3) → `보고서 (2/3).pdf`. 확장자는 뒤에 남긴다. */
export function partName(name: string, index: number, total: number): string {
  if (total <= 1) return name;
  const dot = name.lastIndexOf(".");
  const suffix = ` (${index}/${total})`;
  if (dot <= 0) return name + suffix;
  return name.slice(0, dot) + suffix + name.slice(dot);
}
