/**
 * 예약 시각 해석. 사람이 말하는 시각("11시", "내일 9:30")은 모델이 정리해 넘기고, 여기서는
 * 그 문자열을 한 시점으로 바꾼다.
 *
 * 시간대는 한국 표준시(UTC+9)로 고정한다 — 이 앱의 사용자와 서버가 모두 한국에 있고,
 * 한국은 일광 절약 시간이 없어 고정 오프셋으로 정확하다. 오프셋이 붙은 ISO 시각
 * ("…+09:00", "…Z")은 그대로 따른다.
 */
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** 이보다 먼 미래는 받지 않는다 — 잊힌 예약이 몇 달 뒤에 브라우저를 움직이는 일을 막는다. */
export const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

function kstParts(date: Date) {
  const shifted = new Date(date.getTime() + KST_OFFSET_MS);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}

function fromKst(y: number, m: number, d: number, hh: number, mm: number, ss: number): Date {
  return new Date(Date.UTC(y, m, d, hh, mm, ss) - KST_OFFSET_MS);
}

function checkClock(hh: number, mm: number, ss: number): void {
  if (hh > 23 || mm > 59 || ss > 59) throw new Error("시각이 올바르지 않습니다(00:00~23:59).");
}

/**
 * 받는 모양:
 *   "11:00", "9:30:15"            — 오늘 그 시각(이미 지났으면 내일)
 *   "+30m", "+2h", "+30분"         — 지금부터
 *   "2026-10-16 11:00", "2026-10-16T11:00:00" — 한국 시각
 *   "2026-10-16T02:00:00Z", "…+09:00"        — 적힌 오프셋 그대로
 */
export function parseRunAt(input: string, now: Date = new Date()): Date {
  const text = String(input ?? "").trim();
  let at: Date;
  const relative = /^\+(\d{1,5})\s*(m|min|h|hour|분|시간)$/i.exec(text);
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const hours = /^(h|hour|시간)$/i.test(relative[2]!);
    at = new Date(now.getTime() + amount * (hours ? 3_600_000 : 60_000));
  } else if (clock) {
    const [hh, mm, ss] = [Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0)];
    checkClock(hh, mm, ss);
    const { y, m, d } = kstParts(now);
    at = fromKst(y, m, d, hh, mm, ss);
    if (at.getTime() <= now.getTime()) at = fromKst(y, m, d + 1, hh, mm, ss);
  } else if (local) {
    const [hh, mm, ss] = [Number(local[4]), Number(local[5]), Number(local[6] ?? 0)];
    checkClock(hh, mm, ss);
    at = fromKst(Number(local[1]), Number(local[2]) - 1, Number(local[3]), hh, mm, ss);
  } else if (/(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    at = new Date(text);
  } else {
    throw new Error(`시각을 알아볼 수 없습니다: "${text}". "11:00" 또는 "2026-10-16 11:00" 처럼 적어 주세요.`);
  }
  if (Number.isNaN(at.getTime())) throw new Error(`시각을 알아볼 수 없습니다: "${text}".`);
  if (at.getTime() < now.getTime() - 60_000) throw new Error(`이미 지난 시각입니다: ${formatKst(at)}.`);
  if (at.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_MS) throw new Error("30일보다 먼 시각은 예약할 수 없습니다.");
  return at;
}

/** "2026-10-16 11:00:00" (한국 시각). */
export function formatKst(date: Date): string {
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().replace("T", " ").slice(0, 19);
}
