import type { ContextUsageResponse } from "../api/types";

export type MeterTone = "normal" | "summary" | "full";

export interface MeterView {
  /** 0..100, rounded; null when the model reports no window. */
  percent: number | null;
  tone: MeterTone;
  /** Short text beside the ring ("34%"). */
  short: string;
  /** The whole explanation, for the tooltip and screen readers. */
  detail: string;
}

const MODEL_NAME = (model: string) => model.split("/").pop() || model;

/** What the composer's context meter says for one measurement. */
export function meterView(usage: ContextUsageResponse): MeterView {
  const tokens = usage.tokens.toLocaleString();
  const approx = usage.exact ? "" : "약 ";
  const model = MODEL_NAME(usage.model);
  if (!usage.contextWindow) {
    return { percent: null, tone: "normal", short: "—", detail: `컨텍스트 ${approx}${tokens} 토큰 사용 · ${model} 은(는) 컨텍스트 길이를 알려 주지 않습니다.` };
  }
  const ratio = usage.tokens / usage.contextWindow;
  const percent = Math.min(100, Math.round(ratio * 100));
  // 요약 여부는 서버가 실제 요약 판정(needsSummary)으로 정한 값을 따른다 — 백분율만 보고
  // 짐작하면 도구 정의가 더해진 수라 요약이 돌지 않는데도 "요약합니다"를 말했다.
  const tone: MeterTone = ratio >= usage.toolStopRatio ? "full" : usage.willSummarize ? "summary" : "normal";
  // 0% 는 "비어 있다"로 읽힌다 — 조금이라도 썼으면 1% 미만으로 적는다.
  const shown = percent === 0 && usage.tokens > 0 ? "1% 미만" : `${percent}%`;
  const head = `컨텍스트 ${shown} 사용 · ${approx}${tokens} / ${usage.contextWindow.toLocaleString()} 토큰 (${model})`;
  const summaryAt = Math.round(usage.summaryRatio * 100);
  const toolStopAt = Math.round(usage.toolStopRatio * 100);
  const tail =
    tone === "normal"
      ? `대화 기록이 약 ${summaryAt}%를 넘으면 다음 질문에서 이전 대화를 요약해 이어갑니다.`
      : tone === "summary"
        ? "다음 질문을 보낼 때 이전 대화를 요약해 이어갑니다."
        : usage.willSummarize
          ? `${toolStopAt}%를 넘었습니다. 다음 질문을 보낼 때 이전 대화를 요약하고, 줄지 않으면 도구 호출이 멈춥니다.`
          : `${toolStopAt}%를 넘었습니다. 줄지 않으면 이번 질문에서 도구 호출이 멈춥니다.`;
  return { percent, tone, short: shown === "1% 미만" ? "<1%" : shown, detail: `${head}\n${tail}` };
}
