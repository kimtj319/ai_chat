import { useEffect, useRef, useState } from "react";
import { getProhibitions } from "../api/client";
import type { ConversationSettings } from "../api/types";
import { DEFAULT_MAX_TOKENS, MAX_MAX_TOKENS, MIN_MAX_TOKENS } from "../state/defaults";
import { setLeaveGuard } from "../state/leaveGuard";
import { parseMaxTokens } from "../state/settingsInput";
import type { ActiveConversation } from "../state/StoreContext";
import { useActiveConversation, useStore } from "../state/StoreContext";
import { Modal } from "./Modal";
import { PageHeader } from "./PageHeader";
import { ProhibitionsDialog } from "./ProhibitionsDialog";
import { showErrorToast, showToast } from "./Toast";
import "./ConversationSettingsPage.css";

/** The sampling fields this page edits. Everything else in the settings (the
 *  reasoning level and budget the composer owns) is left as it is stored. */
type Sampling = Pick<ConversationSettings, "temperature" | "topP" | "frequencyPenalty" | "presencePenalty" | "maxTokens" | "seed">;

function samplingOf(settings: ConversationSettings): Sampling {
  const { temperature, topP, frequencyPenalty, presencePenalty, maxTokens, seed } = settings;
  return { temperature, topP, frequencyPenalty, presencePenalty, maxTokens, seed };
}

function sameSampling(a: Sampling, b: Sampling): boolean {
  return (
    a.temperature === b.temperature &&
    a.topP === b.topP &&
    a.frequencyPenalty === b.frequencyPenalty &&
    a.presencePenalty === b.presencePenalty &&
    a.maxTokens === b.maxTokens &&
    (a.seed ?? null) === (b.seed ?? null)
  );
}

/**
 * 대화 설정 — 도구 설정·라이브러리처럼 사이드바 옆 본문에 뜨는 화면.
 *
 * 예전에는 창(모달)으로 떠서 고치는 대로 곧장 저장되었다. 이제는 고친 것이 이 화면에만
 * 머물다가 "적용"을 눌러야 대화에 들어간다 — 슬라이더를 끌어 보며 값을 고르는 동안
 * 중간값이 하나하나 저장되지 않고, 마음이 바뀌면 "되돌리기"로 저장된 값으로 돌아간다.
 */
export function ConversationSettingsPage({ onBack }: { onBack: () => void }) {
  const { activeConversation, activeConversationLoading } = useActiveConversation();
  return (
    <div className="conv-settings-page">
      {activeConversation ? (
        <SettingsBody key={activeConversation.id} conversation={activeConversation} onBack={onBack} />
      ) : (
        <SettingsHeader
          onBack={onBack}
          subtitle={activeConversationLoading ? "불러오는 중…" : "대화를 먼저 열면 그 대화의 설정을 바꿀 수 있습니다."}
        />
      )}
    </div>
  );
}

function SettingsHeader({ onBack, subtitle }: { onBack: () => void; subtitle: string }) {
  return <PageHeader title="대화 설정" subtitle={subtitle} onBack={onBack} />;
}

function SettingsBody({ conversation, onBack }: { conversation: ActiveConversation; onBack: () => void }) {
  const { updateSystemPrompt, updateSettings } = useStore();
  const [systemPrompt, setSystemPrompt] = useState(conversation.systemPrompt);
  const [sampling, setSampling] = useState<Sampling>(() => samplingOf(conversation.settings));
  // Max Tokens 는 칸에 적힌 글자 그대로 둔다. 숫자로 바로 바꾸면 칸을 비우는 순간 0 이 들어가고,
  // 범위를 벗어난 값을 칸에 둔 채로 알려 줄 수도 없다.
  const [maxTokensText, setMaxTokensText] = useState(() => String(conversation.settings.maxTokens));
  const [applying, setApplying] = useState(false);

  const maxTokens = parseMaxTokens(maxTokensText);
  // 잘못 적힌 Max Tokens 는 저장된 값과 다르다고 친다 — 고친 것이 있다고 알려야 한다.
  const edited: Sampling = { ...sampling, maxTokens: maxTokens.ok ? maxTokens.value : Number.NaN };
  const promptChanged = systemPrompt !== conversation.systemPrompt;
  const samplingChanged = !sameSampling(edited, samplingOf(conversation.settings));
  const dirty = promptChanged || samplingChanged;
  const canApply = dirty && maxTokens.ok && !applying;

  function patch(next: Partial<Sampling>) {
    setSampling((current) => ({ ...current, ...next }));
  }

  function revert() {
    setSystemPrompt(conversation.systemPrompt);
    setSampling(samplingOf(conversation.settings));
    setMaxTokensText(String(conversation.settings.maxTokens));
  }

  /** 적용했으면 true. 떠나기 전 확인의 "적용하고 이동" 이 결과를 보고 움직인다. */
  async function apply(): Promise<boolean> {
    if (!maxTokens.ok) return false;
    setApplying(true);
    try {
      if (promptChanged) await updateSystemPrompt(systemPrompt);
      // Merged onto what is stored now, so a reasoning level changed elsewhere
      // since this page opened is not written back over.
      if (samplingChanged) await updateSettings({ ...conversation.settings, ...edited });
      showToast("대화 설정을 적용했습니다.");
      return true;
    } catch (err) {
      showErrorToast(err);
      return false;
    } finally {
      setApplying(false);
    }
  }

  // 적용하지 않은 변경을 들고 다른 화면으로 가려 하면 먼저 묻는다. 이 화면은 "적용" 을
  // 눌러야 들어가는 방식이라, 묻지 않으면 고친 것이 말없이 사라진다.
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const leavingRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!dirty) return;
    return setLeaveGuard((proceed) => {
      leavingRef.current = proceed;
      setLeaving(() => proceed);
    });
  }, [dirty]);
  // 묻는 사이에 이 화면이 내려가면(사이드바에서 다른 대화를 골라 대화가 바뀐 경우) 하려던
  // 이동은 그대로 한다 — 예전과 같은 결과다. 고친 값은 대화와 함께 이미 사라졌다.
  useEffect(
    () => () => {
      leavingRef.current?.();
    },
    [],
  );
  function settleLeaving(go: boolean) {
    const proceed = leavingRef.current;
    leavingRef.current = null;
    setLeaving(null);
    if (go) proceed?.();
  }

  // 탭을 닫거나 새로 고칠 때. 문구는 브라우저가 정한다.
  useEffect(() => {
    if (!dirty) return;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // 하지 말 것 목록은 계정 하나에 하나(모든 대화에 적용)지만, 답변이 마음에 들지 않을 때
  // 찾는 곳이 대화 설정이라 여기서 연다. 검토 대기는 대화 도중 서버가 보태므로 열 때마다 센다.
  const [prohibitionsOpen, setProhibitionsOpen] = useState(false);
  const [prohibitionsPending, setProhibitionsPending] = useState(0);
  useEffect(() => {
    if (prohibitionsOpen) return;
    let alive = true;
    getProhibitions()
      .then((res) => alive && setProhibitionsPending(res.pendingCount))
      .catch(() => {
        // 개수를 못 세도 목록은 열 수 있다.
      });
    return () => {
      alive = false;
    };
  }, [prohibitionsOpen]);

  return (
    <>
      <SettingsHeader onBack={onBack} subtitle={`「${conversation.title}」에만 적용됩니다`} />

      <div className="conv-settings-body">
        <section className="conv-settings-card" aria-labelledby="conv-settings-prompt">
          <div className="field">
            <label id="conv-settings-prompt" htmlFor="system-prompt">
              시스템 프롬프트
            </label>
            <textarea
              id="system-prompt"
              rows={7}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              placeholder="예: 당신은 친절한 한국어 코딩 어시스턴트입니다."
            />
          </div>
        </section>

        <section className="conv-settings-card" aria-labelledby="conv-settings-sampling">
          <h2 id="conv-settings-sampling" className="conv-settings-card-title">
            샘플링 파라미터
          </h2>
          <div className="param-grid">
            <div className="field">
              <label htmlFor="param-temperature">Temperature ({sampling.temperature.toFixed(2)})</label>
              <input
                id="param-temperature"
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={sampling.temperature}
                onChange={(event) => patch({ temperature: Number(event.target.value) })}
              />
            </div>

            <div className="field">
              <label htmlFor="param-top-p">Top P ({sampling.topP.toFixed(2)})</label>
              <input
                id="param-top-p"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={sampling.topP}
                onChange={(event) => patch({ topP: Number(event.target.value) })}
              />
            </div>

            <div className="field">
              <label htmlFor="param-frequency">Frequency Penalty ({sampling.frequencyPenalty.toFixed(2)})</label>
              <input
                id="param-frequency"
                type="range"
                min={-2}
                max={2}
                step={0.1}
                value={sampling.frequencyPenalty}
                onChange={(event) => patch({ frequencyPenalty: Number(event.target.value) })}
              />
            </div>

            <div className="field">
              <label htmlFor="param-presence">Presence Penalty ({sampling.presencePenalty.toFixed(2)})</label>
              <input
                id="param-presence"
                type="range"
                min={-2}
                max={2}
                step={0.1}
                value={sampling.presencePenalty}
                onChange={(event) => patch({ presencePenalty: Number(event.target.value) })}
              />
            </div>

            <div className="field">
              <label htmlFor="param-max-tokens">
                Max Tokens <span className="field-hint">({MIN_MAX_TOKENS.toLocaleString()}–{MAX_MAX_TOKENS.toLocaleString()})</span>
              </label>
              <input
                id="param-max-tokens"
                type="number"
                min={MIN_MAX_TOKENS}
                max={MAX_MAX_TOKENS}
                step={256}
                placeholder={`비워 두면 기본값 ${DEFAULT_MAX_TOKENS.toLocaleString()}`}
                value={maxTokensText}
                onChange={(event) => setMaxTokensText(event.target.value)}
                aria-invalid={maxTokens.ok ? undefined : true}
                aria-describedby={maxTokens.ok ? undefined : "param-max-tokens-error"}
              />
              {!maxTokens.ok && (
                <span id="param-max-tokens-error" className="field-error">
                  {maxTokens.message}
                </span>
              )}
            </div>

            <div className="field">
              <label htmlFor="param-seed">Seed (선택)</label>
              <input
                id="param-seed"
                type="number"
                placeholder="비워 두면 무작위"
                value={sampling.seed ?? ""}
                onChange={(event) => {
                  const raw = event.target.value;
                  patch({ seed: raw.trim().length === 0 ? null : Number(raw) });
                }}
              />
            </div>
          </div>
        </section>

        <section className="conv-settings-card" aria-labelledby="conv-settings-prohibitions">
          <h2 id="conv-settings-prohibitions" className="conv-settings-card-title">
            하지 말 것 목록
          </h2>
          <div className="settings-prohibitions">
            <p className="settings-prohibitions-text">
              모든 대화의 답변에 지켜야 할 규칙입니다. 답변에 "하지 마"라고 하면 검토 대기에 쌓이고, 반영한 것만 적용됩니다.
            </p>
            <button type="button" className="btn btn-secondary" onClick={() => setProhibitionsOpen(true)}>
              목록 열기
              {prohibitionsPending > 0 && (
                <span className="settings-prohibitions-badge" aria-label={`검토 대기 ${prohibitionsPending}건`}>
                  {prohibitionsPending}
                </span>
              )}
            </button>
          </div>
        </section>
      </div>

      {/* 아래에 붙어 있어 목록을 어디까지 내렸든 늘 닿는다. */}
      <footer className="conv-settings-actions">
        <div className="conv-settings-actions-row">
          <span className="conv-settings-state" role="status">
            {applying
              ? "적용하는 중…"
              : !maxTokens.ok
                ? "Max Tokens 값을 고쳐야 적용할 수 있습니다"
                : dirty
                  ? "적용하지 않은 변경이 있습니다"
                  : "저장된 설정과 같습니다"}
          </span>
          <button type="button" className="btn btn-secondary" disabled={!dirty || applying} onClick={revert}>
            되돌리기
          </button>
          <button type="button" className="btn btn-primary" disabled={!canApply} onClick={() => void apply()}>
            적용
          </button>
        </div>
      </footer>

      {leaving && (
        <Modal title="적용하지 않은 변경이 있습니다" onClose={() => settleLeaving(false)} width={420}>
          <p className="confirm-message">
            이 화면을 떠나면 바꾼 설정이 사라집니다.
            {!maxTokens.ok && " Max Tokens 값이 범위를 벗어나 지금은 적용할 수 없습니다."}
          </p>
          <div className="confirm-actions">
            <button type="button" className="btn btn-secondary" onClick={() => settleLeaving(false)}>
              취소
            </button>
            <button type="button" className="btn btn-secondary" disabled={applying} onClick={() => settleLeaving(true)}>
              버리고 이동
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canApply}
              onClick={() => void apply().then((ok) => ok && settleLeaving(true))}
            >
              적용하고 이동
            </button>
          </div>
        </Modal>
      )}

      {prohibitionsOpen && <ProhibitionsDialog onClose={() => setProhibitionsOpen(false)} />}
    </>
  );
}
