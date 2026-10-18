/**
 * 흘러 들어오는 답변의 마크다운에서, 아직 다 오지 않은 표 줄을 잠시 감춘다.
 *
 * 표는 한 줄씩 온다. 반쯤 온 줄("| 서울 | 9,5")은 칸이 모자란 행으로 그려졌다가
 * 다음 조각에 칸이 늘며 표 전체의 열 너비가 흔들리고, 구분선(|---|)이 오기 전의
 * 머리 줄은 표가 아닌 글로 보였다가 표로 바뀐다. 둘 다 그 줄이 끝날 때까지 기다리면
 * 사라진다 — 그 사이 보이지 않는 것은 한 줄뿐이다.
 *
 * 첫 데이터 행이 오기 전의 표(머리 줄 + 구분선)도 감춘다. 내용 없는 표는 빈 공간을
 * 열마다 고르게 나눠 그렸다가 첫 행에서 전혀 다른 비율로 바뀐다 — 첫 열이 넓다가
 * 좁아지는 그 출렁임이다.
 */
const TABLE_LINE = /^\s*\|/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const FENCE_LINE = /^ {0,3}(```|~~~)/;
// 줄 하나가 마커만(제목 #, 목록 -, *, 1., 인용 >) 도착한 상태.
const LONE_MARKER = /^\s*(#{1,6}|-|\*|\d+\.|>)\s*$/;

export function stableStreamingMarkdown(source: string): string {
  let text = source;
  // 0) 코드 울타리. 열린 채 오는 중이면 코드 블록으로 그대로 보여 주되, 울타리 줄이
  //    "```" + 반쯤 온 언어명으로만 와 있으면 그 줄을 감춘다.
  let fences = text.split("\n").filter((l) => FENCE_LINE.test(l)).length;
  const tailStart = text.lastIndexOf("\n") + 1;
  if (fences % 2 === 1 && /^ {0,3}(```|~~~)[^`\s]*$/.test(text.slice(tailStart))) {
    text = text.slice(0, tailStart);
    fences -= 1;
  }
  if (fences % 2 === 1) return text;
  // 0a) 반쯤 온 줄바꿈 태그("<", "<b", "<br", "<br /")는 글자로 번쩍이지 않게 감춘다.
  text = text.replace(/<(b(r\s*\/?)?)?$/i, "");
  // 0b) 마지막 줄이 마커 하나뿐이면 감춘다.
  if (LONE_MARKER.test(text.slice(text.lastIndexOf("\n") + 1))) text = text.slice(0, text.lastIndexOf("\n") + 1);
  // 1) 끝나지 않은 마지막 줄이 표 줄이면 줄이 끝날 때까지 감춘다.
  const lastBreak = text.lastIndexOf("\n");
  if (TABLE_LINE.test(text.slice(lastBreak + 1))) text = text.slice(0, lastBreak + 1);
  // 2) 끝에 붙은 표가 머리 줄뿐이거나 머리 줄 + 구분선뿐이면(데이터 행이 아직) 감춘다.
  const lines = text.replace(/\n$/, "").split("\n");
  let start = lines.length;
  while (start > 0 && TABLE_LINE.test(lines[start - 1]!)) start--;
  const block = lines.length - start;
  if (block === 1 || (block === 2 && TABLE_DIVIDER.test(lines[lines.length - 1]!))) {
    lines.length = start;
    return lines.length > 0 ? `${lines.join("\n")}\n` : "";
  }
  return text;
}

/**
 * 답변을 '다 끝난 블록' 묶음들과 아직 자라는 꼬리로 나눈다. 흘러 들어오는 동안 끝난
 * 묶음은 다시 해석하지 않고(MarkdownRenderer 가 묶음마다 memo 한다) 꼬리만 다시 그리게
 * 하려는 것 — 통째로 다시 그리면 답이 길수록 조각 하나에 드는 시간이 길이에 비례해 는다.
 *
 * 나눈 조각을 하나씩 그려 "\n" 으로 이어 붙인 결과는 통째로 그린 것과 같아야 한다.
 * 그래서 자르는 자리는 앞뒤 어느 쪽 해석도 바꿀 수 없는 곳뿐이다: 울타리(``` ~~~ $$)
 * 밖의 빈 줄 다음, 들여쓰지 않았고 목록 표시로 시작하지 않는 '다 온' 줄의 앞.
 *   - 들여쓴 줄·목록 표시 줄은 앞 목록에 이어질 수 있다(느슨한 목록).
 *   - 참조 정의·각주 정의("[x]: …", "[^1]: …")는 문서 전체에 걸리므로 하나라도 있으면
 *     나누지 않는다.
 *   - "<" 로 시작하는 줄(HTML 블록)은 빈 줄을 넘어 이어질 수 있어 그 뒤로는 자르지 않는다.
 * 줄이 다 와야(뒤에 "\n") 자르므로, 한 번 정한 자리는 글이 늘어도 바뀌지 않는다.
 *
 * 너무 잘게 나누면 묶음마다 파서를 새로 세우는 비용이 커지므로, 한 묶음은 적어도
 * minChars 글자를 모은 뒤에 끊는다. 앞에서부터 차례로 정하므로 이것도 글이 늘어도
 * 바뀌지 않는다.
 */
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const DEFINITION = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?\[[^\]\n]+\]:/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,}|\${2,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,}|\${2,})[ \t]*$/;

export function splitMarkdownBlocks(text: string, minChars = 1500): string[] {
  const lines = text.split("\n");
  if (lines.some((line) => DEFINITION.test(line))) return [text];
  const blocks: string[] = [];
  let start = 0;
  let offset = 0;
  let fence: { char: string; length: number } | null = null;
  let prevBlank = false;
  // 마지막 원소는 아직 끝나지 않은 줄(또는 "")이라 보지 않는다.
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = null;
    } else {
      if (/^ {0,3}</.test(line)) break;
      const blank = line.trim() === "";
      if (prevBlank && !blank && offset - start >= minChars && !/^[ \t]/.test(line) && !LIST_MARKER.test(line)) {
        blocks.push(text.slice(start, offset));
        start = offset;
      }
      const open = FENCE_OPEN.exec(line);
      // ``` 와 $$ 의 정보 문자열에는 같은 표시 글자가 올 수 없다("$$x$$" 는 한 줄 수식이다).
      if (open && (open[1]![0] === "~" || !open[2]!.includes(open[1]![0]!))) {
        fence = { char: open[1]![0]!, length: open[1]!.length };
      }
      prevBlank = blank;
    }
    offset += line.length + 1;
  }
  blocks.push(text.slice(start));
  return blocks;
}
