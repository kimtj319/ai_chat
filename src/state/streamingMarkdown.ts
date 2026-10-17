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
