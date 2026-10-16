/**
 * The part of a message's notice that is still shown.
 *
 * The context-summary announcement ("컨텍스트 한도에 도달하여 이전 대화 N개를
 * 요약해 이어갑니다…") is no longer sent, but answers stored before that change
 * still carry it, joined with "\n" to any other notice of the same turn. Those
 * lines are dropped here; everything else stays.
 */
const SUMMARY_NOTICE = /^컨텍스트 한도에 도달하여 이전 대화 \d+개를 요약해 이어갑니다\./;

export function visibleNotice(notice: string | undefined): string | null {
  if (!notice) return null;
  const kept = notice.split("\n").filter((line) => !SUMMARY_NOTICE.test(line.trim()));
  const text = kept.join("\n").trim();
  return text.length > 0 ? text : null;
}
