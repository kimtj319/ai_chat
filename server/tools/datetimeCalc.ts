import type { ToolDefinition } from "./types.js";

interface Shift {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/** Offset (minutes, east-positive) of `timeZone` at the instant `date`. */
function tzOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(date)
    .reduce(
      (acc, p) => {
        acc[p.type] = p.value;
        return acc;
      },
      {} as Record<string, string>,
    );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - date.getTime()) / 60_000;
}

function offsetString(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function assertValidTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`Unknown or invalid IANA timezone: "${tz}"`);
  }
}

/**
 * Resolve `datetime` to an absolute instant. A string with an explicit
 * offset (or "Z"), or no `datetime` at all, is unambiguous. A naive string
 * (no offset) is interpreted as wall-clock time in `sourceTimezone`, via the
 * standard "format as if UTC, then subtract that zone's offset at that
 * instant" trick — a good approximation, occasionally off by the DST shift
 * right at a transition edge.
 */
function resolveStart(datetime: string | undefined, sourceTimezone: string): Date {
  if (!datetime || !datetime.trim()) return new Date();
  const trimmed = datetime.trim();
  if (HAS_OFFSET.test(trimmed)) {
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid datetime: "${datetime}"`);
    return date;
  }
  const asIfUtc = new Date(`${trimmed}Z`);
  if (Number.isNaN(asIfUtc.getTime())) {
    throw new Error(`Invalid datetime: "${datetime}" — use ISO 8601, e.g. "2026-09-11T10:00:00".`);
  }
  const offset = tzOffsetMinutes(asIfUtc, sourceTimezone);
  return new Date(asIfUtc.getTime() - offset * 60_000);
}

export const datetimeCalcTool: ToolDefinition = {
  name: "datetime_calc",
  description:
    'Convert a date/time into a different IANA timezone and/or shift it by an amount of time (add or subtract ' +
    'days/hours/minutes/seconds). Use this for "what time is it in Tokyo when it\'s 3pm here" or "what date is ' +
    '30 days from now". For just the current time, use get_current_time instead.',
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      datetime: {
        type: "string",
        description:
          'ISO 8601 datetime to start from, e.g. "2026-09-11T10:00:00Z" or "2026-09-11T10:00:00" (no offset). ' +
          "Omit to use the current time.",
      },
      source_timezone: {
        type: "string",
        description:
          'IANA timezone used to interpret `datetime` when it has no UTC offset, e.g. "Asia/Seoul". Ignored if ' +
          "datetime already has an offset/Z, or is omitted. Defaults to UTC.",
      },
      shift: {
        type: "object",
        description: "Amount of time to add to the start; use negative numbers to subtract. Fields combine.",
        properties: {
          days: { type: "number" },
          hours: { type: "number" },
          minutes: { type: "number" },
          seconds: { type: "number" },
        },
        additionalProperties: false,
      },
      target_timezone: {
        type: "string",
        description: 'IANA timezone to express the result in, e.g. "America/New_York". Defaults to UTC.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(args: { datetime?: string; source_timezone?: string; shift?: Shift; target_timezone?: string }) {
    const sourceTimezone = args?.source_timezone?.trim() || "UTC";
    const targetTimezone = args?.target_timezone?.trim() || "UTC";
    assertValidTimezone(sourceTimezone);
    assertValidTimezone(targetTimezone);

    const start = resolveStart(args?.datetime, sourceTimezone);

    const shift = args?.shift ?? {};
    for (const [key, value] of Object.entries(shift)) {
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
        throw new Error(`shift.${key} must be a finite number`);
      }
    }
    const shiftMs =
      (shift.days ?? 0) * 86_400_000 +
      (shift.hours ?? 0) * 3_600_000 +
      (shift.minutes ?? 0) * 60_000 +
      (shift.seconds ?? 0) * 1_000;
    const result = new Date(start.getTime() + shiftMs);

    const resultOffset = tzOffsetMinutes(result, targetTimezone);
    const human = new Intl.DateTimeFormat("en-US", {
      timeZone: targetTimezone,
      dateStyle: "full",
      timeStyle: "long",
    }).format(result);

    return {
      startIso: start.toISOString(),
      shiftApplied: {
        days: shift.days ?? 0,
        hours: shift.hours ?? 0,
        minutes: shift.minutes ?? 0,
        seconds: shift.seconds ?? 0,
      },
      resultIso: result.toISOString(),
      targetTimezone,
      resultUtcOffset: offsetString(resultOffset),
      resultHuman: human,
    };
  },
};
