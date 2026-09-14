/**
 * 로그에 **누구의 요청인지**와 **얼마나 중요한지**를 붙인다.
 *
 * 왜 필요한가: 이 서버의 로그는 121줄의 자유 문장이었고, 요청을 가리키는 것이
 * 아무것도 없었다. 사용자가 "11시쯤 문서 올릴 때 안 됐어요" 라고 하면, 그 시각
 * 근처의 모든 줄을 눈으로 읽으며 어느 것이 그 사람의 요청인지 짐작해야 했다.
 * 동시에 여러 사람이 쓰면 짐작도 못 한다.
 *
 * 어떻게 붙이는가: 호출부 121곳을 고치지 않는다. 요청 하나가 도는 동안의
 * 비동기 문맥을 AsyncLocalStorage 에 담아 두고, console 을 한 겹 감싸 그 안에서
 * 나온 줄에만 id 를 붙인다. 그래서 기존 코드는 그대로 두고도
 *
 *     [rag] 색인 시작 ...              →   [a3f1] [rag] 색인 시작 ...
 *
 * 이 된다. 요청 밖에서 나온 줄(기동, 청소 작업)은 붙일 id 가 없으니 그대로다 —
 * 그것도 사실이라, 없는 id 를 지어내지 않는다.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

const requestStore = new AsyncLocalStorage<string>();

/** 요청 하나가 도는 동안 이 id 를 문맥에 달아 둔다. */
export function runWithRequestId<T>(id: string, fn: () => T): T {
  return requestStore.run(id, fn);
}

/** 지금 어느 요청 안인가. 요청 밖이면 undefined. */
export function currentRequestId(): string | undefined {
  return requestStore.getStore();
}

/**
 * 짧은 id. 추적용이지 비밀이 아니므로 4바이트면 충분하다 — 같은 로그 파일
 * 안에서 겹치지 않기만 하면 되고, 길면 매 줄이 그만큼 읽기 나빠진다.
 */
export function newRequestId(): string {
  return crypto.randomBytes(4).toString("hex");
}

/**
 * 밖에서 받은 id 를 그대로 쓸 수 있는가. 로그에 들어갈 값이므로 줄바꿈이나
 * 제어문자가 섞이면 로그 한 줄을 위조할 수 있다 — 그래서 짧은 영숫자만 받는다.
 */
export function sanitizeRequestId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(trimmed) ? trimmed : null;
}

/* ------------------------------------------------------------------- 레벨 */

export const LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type Level = (typeof LEVELS)[number];

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function configuredLevel(): Level {
  const raw = (process.env.LOG_LEVEL || "info").trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(raw) ? (raw as Level) : "info";
}

/** 이 레벨의 줄을 남길 것인가. */
export function levelEnabled(level: Level): boolean {
  return RANK[level] >= RANK[configuredLevel()];
}

/**
 * 평소에는 안 남기지만 문제를 쫓을 때 켜는 줄.
 *
 * console.log 를 쓰지 않는 이유: 지금 있는 121줄은 전부 "남아야 하는" 줄이고,
 * 레벨을 도입하면서 그것들을 하나씩 분류하는 것은 이 작업의 범위가 아니다.
 * 새로 더하는 상세 기록만 이 문을 쓰면, 기존 동작은 그대로 두고도 LOG_LEVEL 로
 * 조절할 수 있는 자리가 생긴다.
 */
export function debug(...args: unknown[]): void {
  if (levelEnabled("debug")) console.log(...args);
}

/* --------------------------------------------------------------- console */

let installed = false;

/**
 * console.log/warn/error 를 감싸 요청 id 를 앞에 붙이고, 레벨로 거른다.
 *
 * logFile.ts 가 이미 console 을 감싸 파일로 흘려보내므로 **그 뒤에** 걸어야
 * 한다 — 그래야 파일에도 id 가 남는다. 두 번 걸리지 않도록 한 번만 돈다.
 */
export function installRequestIdPrefix(): void {
  if (installed) return;
  installed = true;
  const levelOf: Record<"log" | "warn" | "error", Level> = { log: "info", warn: "warn", error: "error" };
  for (const method of ["log", "warn", "error"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (!levelEnabled(levelOf[method])) return;
      const id = currentRequestId();
      if (id) original(`[${id}]`, ...args);
      else original(...args);
    };
  }
}
