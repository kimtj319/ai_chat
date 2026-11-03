import type { ContextUsageResponse } from "../api/types";

export type MeterTone = "normal" | "summary" | "full";

/** What the server sent mid-turn: the size of the request this round actually sends. */
export interface LiveContext {
  tokens: number;
  contextWindow: number | null;
  summaryRatio: number;
  toolStopRatio: number;
}

export interface MeterView {
  /** 0..100, rounded; null when the model reports no window. */
  percent: number | null;
  tone: MeterTone;
  /** Short text beside the ring ("34%"). */
  short: string;
  /** The whole explanation, for the panel and screen readers. */
  detail: string;
}

/** Amber starts this far below the compaction line, so it never arrives unannounced. */
const WARN_BEFORE = 0.1;

const MODEL_NAME = (model: string) => model.split("/").pop() || model;

/**
 * What the composer's context meter says. Between turns it is the server's
 * measurement of the next request (ContextUsageResponse); while a turn runs,
 * `live` replaces the numbers with the size of the request each round sends.
 */
export function meterView(usage: ContextUsageResponse | null, model: string, live?: LiveContext | null): MeterView {
  const tokens = live ? live.tokens : (usage?.tokens ?? 0);
  const contextWindow = (live?.contextWindow ?? null) || (usage?.contextWindow ?? null);
  const summaryRatio = live?.summaryRatio ?? usage?.summaryRatio ?? 0.8;
  const toolStopRatio = live?.toolStopRatio ?? usage?.toolStopRatio ?? 0.8;
  const exact = live ? true : (usage?.exact ?? false);
  const name = MODEL_NAME(usage?.model ?? model);
  const approx = exact ? "" : "약 ";
  const prefix = live ? "답변 중 · " : "";
  const count = `${approx}${tokens.toLocaleString()}`;
  if (!contextWindow) {
    return { percent: null, tone: "normal", short: "—", detail: `${prefix}컨텍스트 ${count} 토큰 사용 · ${name} 은(는) 컨텍스트 길이를 알려 주지 않습니다.` };
  }
  const ratio = tokens / contextWindow;
  const percent = Math.min(100, Math.round(ratio * 100));
  // 압축 여부는 사이에는 서버가 실제 판정(needsSummary)으로 정한 값을, 답변 중에는 그 라운드의 크기를 따른다.
  const willCompact = live ? ratio >= summaryRatio : (usage?.willSummarize ?? false);
  const tone: MeterTone = willCompact || ratio >= toolStopRatio ? "full" : ratio >= summaryRatio - WARN_BEFORE ? "summary" : "normal";
  // 0% 는 "비어 있다"로 읽힌다 — 조금이라도 썼으면 1% 미만으로 적는다.
  const shown = percent === 0 && tokens > 0 ? "1% 미만" : `${percent}%`;
  const head = `${prefix}컨텍스트 ${shown} 사용 · ${count} / ${contextWindow.toLocaleString()} 토큰 (${name})`;
  const at = Math.round(summaryRatio * 100);
  const tail =
    tone === "normal"
      ? `${at}%가 되면 이전 대화를 압축(요약)해 이어갑니다.`
      : tone === "summary"
        ? `곧 ${at}%에 닿습니다. 닿으면 다음 질문에서 이전 대화를 압축(요약)해 이어갑니다.`
        : live
          ? `${at}%를 넘었습니다. 이번 답변은 모은 자료를 정리(압축)하거나 도구 호출을 멈추고, 다음 질문에서 이전 대화를 압축합니다.`
          : willCompact
            ? "다음 질문을 보낼 때 이전 대화를 압축(요약)해 이어갑니다."
            : `도구 정의까지 합쳐 ${Math.round(toolStopRatio * 100)}%를 넘었습니다. 줄지 않으면 이번 질문에서 도구 호출이 멈출 수 있습니다.`;
  return { percent, tone, short: shown === "1% 미만" ? "<1%" : shown, detail: `${head}\n${tail}` };
}
