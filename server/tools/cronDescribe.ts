import type { ToolDefinition } from "./types.js";

// ---- Field parsing -------------------------------------------------------
//
// A cron field resolves to a set of allowed integer values plus whether its
// raw text was exactly "*". That last bit matters beyond convenience: cron's
// day-of-month/day-of-week combination uses OR instead of AND when BOTH
// fields are restricted, and "restricted" means "the raw field text is not
// literally *" — a step expression like "*/5" already counts as restricted
// even though it starts with "*". See `dayMatches` below.

interface FieldSpec {
  raw: string;
  isWildcard: boolean;
  values: Set<number>;
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};
const DOW_NAMES: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};
const MONTH_LABELS = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function resolveValue(token: string, names: Record<string, number> | undefined, originalPart: string): number {
  const named = names?.[token.toUpperCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(token)) {
    throw new Error(`invalid value "${token}" in cron field part "${originalPart}"`);
  }
  return Number(token);
}

function parseFieldPart(
  part: string,
  min: number,
  max: number,
  names: Record<string, number> | undefined,
  values: Set<number>,
): void {
  if (part.length === 0) throw new Error("cron field contains an empty entry (check for a stray comma)");

  let base = part;
  let step = 1;
  const slashIndex = part.indexOf("/");
  if (slashIndex !== -1) {
    base = part.slice(0, slashIndex);
    const stepText = part.slice(slashIndex + 1);
    if (!/^\d+$/.test(stepText) || Number(stepText) <= 0) {
      throw new Error(`invalid step "${part}" (step must be a positive integer)`);
    }
    step = Number(stepText);
  }

  let rangeStart: number;
  let rangeEnd: number;
  if (base === "*") {
    rangeStart = min;
    rangeEnd = max;
  } else if (base.includes("-")) {
    const dashIndex = base.indexOf("-");
    const startToken = base.slice(0, dashIndex);
    const endToken = base.slice(dashIndex + 1);
    rangeStart = resolveValue(startToken, names, part);
    rangeEnd = resolveValue(endToken, names, part);
    if (rangeStart > rangeEnd) {
      throw new Error(`invalid range "${part}": start (${rangeStart}) is greater than end (${rangeEnd})`);
    }
  } else {
    rangeStart = rangeEnd = resolveValue(base, names, part);
  }

  if (rangeStart < min || rangeEnd > max) {
    throw new Error(`value out of range in "${part}" (expected ${min}-${max})`);
  }
  for (let v = rangeStart; v <= rangeEnd; v += step) values.add(v);
}

function parseField(raw: string, min: number, max: number, names?: Record<string, number>): FieldSpec {
  const values = new Set<number>();
  for (const part of raw.split(",")) parseFieldPart(part, min, max, names, values);
  return { raw, isWildcard: raw === "*", values };
}

function parseCron(expression: string): { minute: FieldSpec; hour: FieldSpec; dom: FieldSpec; month: FieldSpec; dow: FieldSpec } {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}: "${expression}"`,
    );
  }
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields as [string, string, string, string, string];
  const minute = parseField(minuteRaw, 0, 59);
  const hour = parseField(hourRaw, 0, 23);
  const dom = parseField(domRaw, 1, 31);
  const month = parseField(monthRaw, 1, 12, MONTH_NAMES);
  const dow = parseField(dowRaw, 0, 7, DOW_NAMES);
  // Cron allows both 0 and 7 to mean Sunday in the day-of-week field.
  if (dow.values.has(7)) {
    dow.values.delete(7);
    dow.values.add(0);
  }
  return { minute, hour, dom, month, dow };
}

// ---- Plain-language description ------------------------------------------

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function describeTime(minute: FieldSpec, hour: FieldSpec): string {
  if (minute.isWildcard && hour.isWildcard) return "every minute";

  const stepMatch = /^\*\/(\d+)$/.exec(minute.raw);
  if (stepMatch && hour.isWildcard) return `every ${stepMatch[1]} minutes`;

  const minutes = [...minute.values].sort((a, b) => a - b);
  const hours = [...hour.values].sort((a, b) => a - b);

  if (minutes.length === 1 && hours.length === 1) {
    return `at ${pad2(hours[0]!)}:${pad2(minutes[0]!)}`;
  }
  if (hour.isWildcard) {
    return `at minute${minutes.length > 1 ? "s" : ""} ${minutes.join(", ")} of every hour`;
  }
  if (minute.isWildcard) {
    return `every minute during hour${hours.length > 1 ? "s" : ""} ${hours.join(", ")}`;
  }
  return `at minute${minutes.length > 1 ? "s" : ""} ${minutes.join(", ")} past hour${hours.length > 1 ? "s" : ""} ${hours.join(", ")}`;
}

function describeCron(fields: ReturnType<typeof parseCron>): string {
  const parts = [describeTime(fields.minute, fields.hour)];

  const domPhrase = fields.dom.isWildcard
    ? null
    : `on day-of-month ${[...fields.dom.values].sort((a, b) => a - b).join(", ")}`;
  const dowPhrase = fields.dow.isWildcard
    ? null
    : `on ${[...fields.dow.values].sort((a, b) => a - b).map((v) => DOW_LABELS[v]).join(", ")}`;
  const monthPhrase = fields.month.isWildcard
    ? null
    : `in ${[...fields.month.values].sort((a, b) => a - b).map((v) => MONTH_LABELS[v]).join(", ")}`;

  if (domPhrase && dowPhrase) {
    parts.push(`${domPhrase} OR ${dowPhrase} (cron treats day-of-month and day-of-week as OR when both are restricted)`);
  } else if (domPhrase) {
    parts.push(domPhrase);
  } else if (dowPhrase) {
    parts.push(dowPhrase);
  }
  if (monthPhrase) parts.push(monthPhrase);

  return `${parts.join(", ")}.`;
}

// ---- Next-run computation --------------------------------------------------

const WEEKDAY_TO_NUMBER: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Stepping minute-by-minute from "now" is the simplest correct way to find
// the next matches for an arbitrary 5-field expression, but a malformed-in-
// spirit (not malformed-in-syntax) expression can describe a date that never
// occurs — e.g. day-of-month 30 in February, every year, forever. Without a
// bound that loop runs forever. Four years' worth of minutes guarantees the
// scan covers at least one leap year, so a combination that's merely rare
// (Feb 29) is still found, while a combination that's truly impossible
// (Feb 30/31, day 31 of a 30-day month) safely exhausts the bound instead of
// hanging the request.
const MAX_LOOKAHEAD_MINUTES = 4 * 366 * 24 * 60;

// The next-run search can step through up to MAX_LOOKAHEAD_MINUTES minutes,
// so the Intl.DateTimeFormat used to read wall-clock fields is built once by
// the caller and reused for every iteration — constructing a new formatter
// per minute (millions of times, in the worst case) is the dominant cost of
// this kind of loop and easily turns a sub-second search into a multi-second
// one.
function getWallClockFields(date: Date, formatter: Intl.DateTimeFormat) {
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    minute: Number(get("minute")),
    hour: Number(get("hour")),
    dayOfMonth: Number(get("day")),
    month: Number(get("month")),
    dayOfWeek: WEEKDAY_TO_NUMBER[get("weekday")]!,
  };
}

function formatInZone(date: Date, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function fieldsMatch(fields: ReturnType<typeof parseCron>, wall: ReturnType<typeof getWallClockFields>): boolean {
  if (!fields.minute.values.has(wall.minute)) return false;
  if (!fields.hour.values.has(wall.hour)) return false;
  if (!fields.month.values.has(wall.month)) return false;

  const domRestricted = !fields.dom.isWildcard;
  const dowRestricted = !fields.dow.isWildcard;
  if (domRestricted && dowRestricted) {
    return fields.dom.values.has(wall.dayOfMonth) || fields.dow.values.has(wall.dayOfWeek);
  }
  if (domRestricted) return fields.dom.values.has(wall.dayOfMonth);
  if (dowRestricted) return fields.dow.values.has(wall.dayOfWeek);
  return true;
}

function findNextRuns(
  fields: ReturnType<typeof parseCron>,
  count: number,
  timeZone: string,
): { runs: Array<{ utc: string; local: string }>; neverFires: boolean } {
  const runs: Array<{ utc: string; local: string }> = [];
  let cursorMs = (Math.floor(Date.now() / 60000) + 1) * 60000; // next whole minute, strictly after now

  const fieldFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const displayFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  for (let i = 0; i < MAX_LOOKAHEAD_MINUTES && runs.length < count; i++) {
    const cursor = new Date(cursorMs);
    if (fieldsMatch(fields, getWallClockFields(cursor, fieldFormatter))) {
      runs.push({ utc: cursor.toISOString(), local: formatInZone(cursor, displayFormatter) });
    }
    cursorMs += 60000;
  }

  return { runs, neverFires: runs.length === 0 };
}

export const cronDescribeTool: ToolDefinition = {
  name: "cron_describe",
  description:
    "Explain a 5-field cron expression (minute hour day-of-month month day-of-week) in plain language and list its next run times in a given timezone. Supports *, lists, ranges, steps and 3-letter month/day names. Says so when the expression describes a date that can never occur.",
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: 'Standard 5-field cron expression, e.g. "*/15 9-17 * * 1-5" (every 15 min, 9am-5pm, weekdays).',
      },
      count: {
        type: "integer",
        description: "How many upcoming run times to return (default 5, max 20).",
        minimum: 1,
        maximum: 20,
      },
      timezone: {
        type: "string",
        description: 'IANA time zone the schedule is interpreted in, e.g. "Asia/Seoul" (default "UTC").',
      },
    },
    required: ["expression"],
    additionalProperties: false,
  },
  async execute(args: { expression: string; count?: number; timezone?: string }) {
    if (typeof args?.expression !== "string" || args.expression.trim().length === 0) {
      throw new Error("expression must be a non-empty cron string");
    }
    const count = args.count ?? 5;
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new Error("count must be an integer between 1 and 20");
    }
    const timezone = args.timezone ?? "UTC";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      throw new Error(`Unknown IANA time zone: "${timezone}"`);
    }

    const fields = parseCron(args.expression);
    const description = describeCron(fields);
    const { runs, neverFires } = findNextRuns(fields, count, timezone);

    return {
      expression: args.expression,
      description,
      timezone,
      nextRuns: runs,
      ...(neverFires
        ? {
            neverFires: true,
            note:
              `No matching run time was found within a ${Math.floor(MAX_LOOKAHEAD_MINUTES / (365 * 24 * 60))}-year ` +
              "lookahead window — this expression likely describes a date that never occurs (e.g. February 30th).",
          }
        : {}),
    };
  },
};
