/**
 * 청크 경계를 모델에게 고르게 한다. 자르는 것은 우리가 한다.
 *
 * 왜 이 모양인가 — 실측했기 때문이다. 모델에게 청크 '본문'을 그대로 내놓게
 * 했더니 828자짜리 문서에서 98.4% 만 돌아왔다. 사라진 것은 제목 줄이었고,
 * 모델은 그것을 알리지 않았다. 텍스트를 옮겨 적는 일을 모델에게 맡기면 원문이
 * 조용히 줄어든다.
 *
 * 그래서 모델에게는 **줄 번호만** 묻는다. 같은 문서에서 0.2초에 8토큰이었고,
 * 원문 보존은 우리가 자르므로 원리상 보장된다 — chunk.test.ts 의 "이월분을
 * 빼고 이으면 원문이 복원된다" 가 이 경로에도 그대로 적용된다.
 *
 * 긴 문서는 창으로 나눈다. 160KB(5만 토큰)를 한 번에 넣어도 응답은 하지만
 * 17.9초가 걸렸고, 6,000자 창으로 쪼개면 창당 772ms 라 동시에 돌려 1~2초에
 * 끝난다. 창 경계는 문단 경계에서 잡으므로, 창을 나눈 것 자체가 문장을
 * 끊지는 않는다.
 */
import { config } from "../config.js";
import { DEFAULT_OVERLAP_CHARS, DEFAULT_TARGET_CHARS, applyOverlap, buildBodies, normalize, type Chunk } from "./chunk.js";

/** 한 번에 모델에게 보여 주는 분량. 실측에서 이 크기가 창당 1초 아래였다. */
const WINDOW_CHARS = 6000;
/** 동시에 띄우는 창 수. 모델 서버를 한 사람의 업로드가 독점하지 않을 만큼만. */
const CONCURRENCY = 8;
/** 창 하나의 제한 시간. 넘으면 그 창만 규칙 기반으로 넘어간다. */
const WINDOW_TIMEOUT_MS = 30_000;
/** 경계 목록은 짧다. 넉넉해도 이 정도면 충분하고, 폭주한 응답을 잘라 낸다. */
const MAX_OUTPUT_TOKENS = 1024;

const SYSTEM_PROMPT =
  "줄 번호가 붙은 문서에서 의미가 끊기는 지점의 줄 번호만 고른다. " +
  "고른 줄이 새 덩어리의 첫 줄이 된다. 각 덩어리가 300~700자가 되도록 고른다. " +
  "설명 없이 정수 JSON 배열만 출력한다. 예: [12, 27, 41]";

export type ChunkMethod = "llm" | "rule";

export interface ChunkPlan {
  chunks: Chunk[];
  /** 경계를 실제로 모델이 골랐는지. 한 창이라도 규칙으로 떨어지면 "rule" 이 아니라, 아래 windows 로 남긴다. */
  method: ChunkMethod;
  /** 창 수와 그중 모델이 답한 창 수. 0/0 이면 모델을 아예 쓰지 않았다는 뜻이다. */
  windows: { total: number; fromModel: number };
  elapsedMs: number;
}

export function llmChunkingConfigured(): boolean {
  return Boolean(config.ragChunkModelUrl && config.ragChunkModel);
}

/**
 * 문서를 청크로 나눈다. 모델이 설정되어 있으면 경계를 묻고, 아니면 규칙만 쓴다.
 *
 * 어느 쪽이든 실패하지 않는다. 모델이 없거나 죽었거나 헛소리를 하면 그 창은
 * 규칙 기반으로 잘린다 — 경계가 조금 덜 좋은 것과 업로드가 실패하는 것 중에서는
 * 앞이 낫고, 사용자는 자기가 고르지 않은 실패를 겪을 이유가 없다.
 */
export async function planChunks(text: string): Promise<ChunkPlan> {
  const started = Date.now();
  const norm = normalize(text);
  if (!llmChunkingConfigured() || !norm.trim()) {
    return {
      chunks: applyOverlap(buildBodies(norm), DEFAULT_OVERLAP_CHARS),
      method: "rule",
      windows: { total: 0, fromModel: 0 },
      elapsedMs: Date.now() - started,
    };
  }

  const windows = splitWindows(norm);
  const results = await mapWithLimit(windows, CONCURRENCY, (w) => bodiesForWindow(w));
  const bodies: string[] = [];
  let fromModel = 0;
  for (const r of results) {
    if (r.fromModel) fromModel++;
    bodies.push(...r.bodies);
  }
  return {
    chunks: applyOverlap(bodies, DEFAULT_OVERLAP_CHARS),
    method: fromModel > 0 ? "llm" : "rule",
    windows: { total: windows.length, fromModel },
    elapsedMs: Date.now() - started,
  };
}

/**
 * 창으로 나눈다. 자르는 자리는 빈 줄(문단 경계)만 고른다 — 창을 나누는 행위
 * 자체가 문장을 끊어 버리면, 모델에게 물어보기도 전에 경계가 나빠진다.
 */
function splitWindows(norm: string): string[] {
  const lines = norm.split("\n");
  const windows: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (let i = 0; i < lines.length; i++) {
    cur.push(lines[i]);
    len += lines[i].length + 1;
    const atBlank = lines[i].trim() === "";
    if (len >= WINDOW_CHARS && atBlank) {
      windows.push(cur.join("\n"));
      cur = [];
      len = 0;
    }
  }
  if (cur.length) windows.push(cur.join("\n"));
  // 문단이 하나도 없는 글은 위에서 한 창으로 남는다. 그런 글은 어차피 규칙
  // 기반이 문장·문자 단위로 내려가 처리하므로 그대로 둔다.
  return windows.filter((w) => w.trim().length > 0);
}

interface WindowResult {
  bodies: string[];
  fromModel: boolean;
}

async function bodiesForWindow(window: string): Promise<WindowResult> {
  const fallback = (): WindowResult => ({ bodies: buildBodies(window), fromModel: false });
  const lines = window.split("\n");
  // 창이 목표 크기 하나에도 못 미치면 물어볼 것이 없다.
  if (window.trim().length <= DEFAULT_TARGET_CHARS) return fallback();

  let cuts: number[];
  try {
    cuts = await askForCuts(lines);
  } catch {
    return fallback();
  }
  const bodies = bodiesFromCuts(lines, cuts);
  // 모델이 아무 경계도 못 골랐으면 규칙이 나은 결과를 낸다.
  if (bodies.length === 0) return fallback();
  return { bodies, fromModel: true };
}

async function askForCuts(lines: string[]): Promise<number[]> {
  const numbered = lines.map((l, i) => `${i + 1}| ${l}`).join("\n");
  const res = await fetch(`${config.ragChunkModelUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.ragChunkToken ? { Authorization: `Bearer ${config.ragChunkToken}` } : {}),
    },
    body: JSON.stringify({
      model: config.ragChunkModel,
      temperature: 0,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: numbered },
      ],
    }),
    signal: AbortSignal.timeout(WINDOW_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = body?.choices?.[0]?.message?.content ?? "";
  // 모델은 코드펜스를 두르거나 한마디 덧붙이기도 한다. 첫 정수 배열만 본다.
  const match = /\[[\s\d,]*\]/.exec(content);
  if (!match) throw new Error("정수 배열이 없습니다");
  const parsed: unknown = JSON.parse(match[0]);
  if (!Array.isArray(parsed)) throw new Error("배열이 아닙니다");
  return parsed.filter((n): n is number => Number.isInteger(n));
}

/**
 * 경계 줄 번호를 본문 배열로 바꾼다. 여기가 모델의 답을 신뢰하지 않는 곳이다.
 *
 * 모델이 내놓는 것은 제안이지 명령이 아니다. 범위 밖·중복·역순은 버리고,
 * 그렇게 만든 덩어리가 목표보다 크면 규칙 기반으로 다시 쪼갠다. 그 마지막
 * 단계가 있어서 청크 길이 상한은 모델이 무엇을 답하든 지켜진다.
 */
function bodiesFromCuts(lines: string[], cuts: number[]): string[] {
  const valid = [...new Set(cuts.filter((n) => n >= 2 && n <= lines.length))].sort((a, b) => a - b);
  if (valid.length === 0) return [];

  const bounds = [1, ...valid, lines.length + 1];
  const bodies: string[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const piece = lines.slice(bounds[i] - 1, bounds[i + 1] - 1).join("\n").trim();
    if (!piece) continue;
    if (piece.length <= DEFAULT_TARGET_CHARS) {
      bodies.push(piece);
      continue;
    }
    // 모델이 너무 넓게 잡았다. 그 덩어리만 규칙으로 다시 나눈다.
    bodies.push(...buildBodies(piece));
  }
  return mergeTiny(bodies);
}

/**
 * 너무 짧은 덩어리를 뒤와 합친다.
 *
 * 모델은 목록이나 표제어 앞에서 자주 끊는데, 20자짜리 청크는 검색에 걸려도
 * 인용할 것이 없다. 합쳐도 목표를 넘지 않을 때만 합치므로 상한은 그대로다.
 */
const MIN_BODY_CHARS = 120;

function mergeTiny(bodies: string[]): string[] {
  const out: string[] = [];
  for (const body of bodies) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.length < MIN_BODY_CHARS && prev.length + 2 + body.length <= DEFAULT_TARGET_CHARS) {
      out[out.length - 1] = `${prev}\n\n${body}`;
      continue;
    }
    out.push(body);
  }
  // 마지막 조각이 홀로 짧게 남았으면 앞과 합친다.
  if (out.length >= 2) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (last.length < MIN_BODY_CHARS && prev.length + 2 + last.length <= DEFAULT_TARGET_CHARS) {
      out.splice(out.length - 2, 2, `${prev}\n\n${last}`);
    }
  }
  return out;
}

/** 순서를 지키면서 동시 실행 수만 묶는다. 창의 순서가 곧 문서의 순서라 결과 순서가 곧 정답이다. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export const _internals = { splitWindows, bodiesFromCuts, mergeTiny, WINDOW_CHARS, DEFAULT_TARGET_CHARS };
