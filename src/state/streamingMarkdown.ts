/**
 * 흘러 들어오는 답변의 마크다운에서, 아직 다 오지 않은 표 줄을 잠시 감춘다.
 *
 * 표는 한 줄씩 온다. 반쯤 온 줄("| 서울 | 9,5")은 칸이 모자란 행으로 그려졌다가
 * 다음 조각에 칸이 늘며 표 전체의 열 너비가 흔들리고, 구분선(|---|)이 오기 전의
 * 머리 줄은 표가 아닌 글로 보였다가 표로 바뀐다. 둘 다 그 줄이 끝날 때까지 기다리면
 * 사라진다 — 그 사이 보이지 않는 것은 한 줄뿐이다.
 */
const TABLE_LINE = /^\s*\|/;

export function stableStreamingMarkdown(source: string): string {
  let text = source;
  // 1) 끝나지 않은 마지막 줄이 표 줄이면 줄이 끝날 때까지 감춘다.
  const lastBreak = text.lastIndexOf("\n");
  if (TABLE_LINE.test(text.slice(lastBreak + 1))) text = text.slice(0, lastBreak + 1);
  // 2) 표의 머리 줄만 와 있고 구분선이 아직이면 그 머리 줄도 감춘다.
  const lines = text.replace(/\n$/, "").split("\n");
  const last = lines[lines.length - 1] ?? "";
  const before = lines[lines.length - 2] ?? "";
  if (TABLE_LINE.test(last) && !TABLE_LINE.test(before)) {
    lines.pop();
    return lines.length > 0 ? `${lines.join("\n")}\n` : "";
  }
  return text;
}
