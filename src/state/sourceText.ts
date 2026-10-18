/**
 * 출처 창의 글 보기에서 줄 머리의 마크다운 제목 표시("## ")를 뗀다.
 *
 * 글 보기는 원문 글자를 그대로 깔고 인용 단락에 형광펜을 긋는다. 마크다운으로 올린 문서는
 * 제목이 "## 13. 일반 점검 항목" 처럼 기호째로 보여 읽기 거슬렸다. 강조 자리(글자 위치)는
 * 원문 기준으로 이미 정해져 있으므로, 원문은 그대로 두고 **그려 넣는 조각마다** 뗀다.
 *
 * atLineStart: 이 조각이 줄 머리에서 시작하는가. 강조가 줄 중간에서 끝나면 다음 조각의
 * 맨 앞은 줄 머리가 아니다 — 그 자리의 "## " 는 제목 표시가 아니라 글자다.
 */
export function stripHeadingMarks(segment: string, atLineStart: boolean): string {
  return segment.replace(/(^|\n)#{1,6}[ \t]+/g, (match: string, lead: string, offset: number) =>
    offset === 0 && lead === "" && !atLineStart ? match : lead,
  );
}
