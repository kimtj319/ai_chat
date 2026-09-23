import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { pushOverlay } from "../ui/overlayStack";
import { normalizeReasoningLevel, normalizeReasoningMode, type ReasoningLevel, type ReasoningMode } from "../api/types";
import { MAX_THINKING_TOKEN_BUDGET, MIN_THINKING_TOKEN_BUDGET } from "../state/defaults";
import "./ReasoningControl.css";

const LEVELS: Array<{ value: ReasoningLevel; label: string; hint: string }> = [
  { value: "off", label: "Off", hint: "생각 없이 바로" },
  { value: "low", label: "Low", hint: "짧게" },
  { value: "medium", label: "Medium", hint: "보통" },
  { value: "xhigh", label: "xHigh", hint: "가장 길게" },
];

/* Measured against the deployed endpoints (139 runs, 2026-09-12):
   wise-lloa-max keeps thinking whatever is sent — enable_thinking:false still
   produced 1,835-2,152 characters in five of five runs, and a budget of 0 still
   produced ~800 tokens. On such a model every level below is a promise the
   model does not keep, so the popover states the fact instead of offering them. */
const FIXED_LEVEL_LABEL = "항상 켜짐";
const FIXED_LEVEL_NOTE = "이 모델은 추론을 조절할 수 없습니다. 항상 생각합니다.";

// "지금 답변하기" 버튼(3분부터)은 두 모드 모두에서 뜬다 — 여기 힌트는 안
// 누르고 두면 무엇이 다른지만 말한다: external 은 끝까지 기다리고, normal 은
// 잊고 켜 둔 탭을 위한 30분 안전 상한이 있다(server/config.ts 참고).
const MODES: Array<{ value: ReasoningMode; label: string; hint: string }> = [
  { value: "external", label: "External", hint: "제한 없음" },
  { value: "normal", label: "Normal", hint: "30분 후 자동 정리" },
];

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

interface ReasoningControlProps {
  level: ReasoningLevel;
  mode: ReasoningMode;
  /** From the catalog entry of the conversation's model; false while it loads. */
  reasoningFixed: boolean;
  thinkingTokenBudget: number;
  onLevelChange: (level: ReasoningLevel) => void;
  onModeChange: (mode: ReasoningMode) => void;
  onBudgetChange: (budget: number) => void;
}

/** The composer's "사고 모델" dropdown in the reference — a text trigger that
 * opens a small popover holding the reasoning level choices and the
 * thinking-token-budget slider. Only the presentation is new here; every
 * value/callback is exactly what the previous always-visible segmented
 * control used. */
export function ReasoningControl({
  level: rawLevel,
  mode: rawMode,
  reasoningFixed,
  thinkingTokenBudget,
  onLevelChange,
  onModeChange,
  onBudgetChange,
}: ReasoningControlProps) {
  // A conversation stored before the ladder was corrected can still carry
  // "high"; fold it to "xhigh" so the right option shows as selected.
  const level = normalizeReasoningLevel(rawLevel);
  // A conversation stored before modes existed has none; that reads as
  // "external", which is the default.
  const mode = normalizeReasoningMode(rawMode);
  const [open, setOpen] = useState(false);

  // 열려 있는 동안은 Esc 가 이쪽 몫이다 — 전역 Esc(생성 중단)와 겹치지 않게.
  useEffect(() => (open ? pushOverlay() : undefined), [open]);
  const containerRef = useRef<HTMLDivElement>(null);
  const currentLabel = LEVELS.find((option) => option.value === level)?.label ?? level;

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" && !open) {
      event.preventDefault();
      setOpen(true);
    }
  }

  return (
    <div className="reasoning-control" ref={containerRef}>
      <button
        type="button"
        className="reasoning-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>추론 · {reasoningFixed ? FIXED_LEVEL_LABEL : currentLabel}</span>
        <ChevronDownIcon />
      </button>

      {open && (
        <div className="reasoning-popover" aria-label="추론 설정">
          {/* Built like the sidebar's menu: full-width rows in a stack, pill
              shaped, no card or border — the selected one is filled the way the
              sidebar fills its current item. */}
          <p className="reasoning-group-label">추론 레벨</p>
          {reasoningFixed ? (
            <p className="reasoning-fixed-note">{FIXED_LEVEL_NOTE}</p>
          ) : (
            <div className="reasoning-options" role="radiogroup" aria-label="추론 레벨">
              {LEVELS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={level === option.value}
                  className={`reasoning-option${level === option.value ? " active" : ""}`}
                  onClick={() => onLevelChange(option.value)}
                >
                  <span className="reasoning-option-label">{option.label}</span>
                  <span className="reasoning-option-hint">{option.hint}</span>
                </button>
              ))}
            </div>
          )}

          <p className="reasoning-group-label">응답 모드</p>
          <div className="reasoning-options" role="radiogroup" aria-label="응답 모드">
            {MODES.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={mode === option.value}
                className={`reasoning-option${mode === option.value ? " active" : ""}`}
                onClick={() => onModeChange(option.value)}
              >
                <span className="reasoning-option-label">{option.label}</span>
                <span className="reasoning-option-hint">{option.hint}</span>
              </button>
            ))}
          </div>

          {!reasoningFixed && level !== "off" && (
            <div className="reasoning-budget">
              {/* Label and value share one row; the slider gets the full width
                  underneath, so neither the label nor the chips have to wrap. */}
              <div className="reasoning-budget-head">
                <label htmlFor="thinking-budget">추론 토큰 한도</label>
                <span className="reasoning-budget-value">{thinkingTokenBudget.toLocaleString()}</span>
              </div>
              <input
                id="thinking-budget"
                type="range"
                min={MIN_THINKING_TOKEN_BUDGET}
                max={MAX_THINKING_TOKEN_BUDGET}
                step={256}
                value={thinkingTokenBudget}
                onChange={(event) => onBudgetChange(Number(event.target.value))}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
