/** "2026. 10. 17. 오후 09:36" — 날짜와 시각을 함께. 읽을 수 없는 값은 그대로 보인다. */
export function formatDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
