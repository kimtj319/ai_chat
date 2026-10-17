import { useEffect, useState } from "react";
import { getProhibitions } from "../api/client";
import type { ConversationSettings } from "../api/types";
import { MAX_MAX_TOKENS, MIN_MAX_TOKENS } from "../state/defaults";
import type { ActiveConversation } from "../state/StoreContext";
import { useActiveConversation, useStore } from "../state/StoreContext";
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
  const [applying, setApplying] = useState(false);

  const promptChanged = systemPrompt !== conversation.systemPrompt;
  const samplingChanged = !sameSampling(sampling, samplingOf(conversation.settings));
  const dirty = promptChanged || samplingChanged;

  function patch(next: Partial<Sampling>) {
    setSampling((current) => ({ ...current, ...next }));
  }

  function revert() {
    setSystemPrompt(conversation.systemPrompt);
    setSampling(samplingOf(conversation.settings));
  }

  async function apply() {
    setApplying(true);
    try {
      if (promptChanged) await updateSystemPrompt(systemPrompt);
      // Merged onto what is stored now, so a reasoning level changed elsewhere
      // since this page opened is not written back over.
      if (samplingChanged) await updateSettings({ ...conversation.settings, ...sampling });
      showToast("대화 설정을 적용했습니다.");
    } catch (err) {
      showErrorToast(err);
    } finally {
      setApplying(false);
    }
  }

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
                value={sampling.maxTokens}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isNaN(value)) patch({ maxTokens: value });
                }}
              />
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
            {applying ? "적용하는 중…" : dirty ? "적용하지 않은 변경이 있습니다" : "저장된 설정과 같습니다"}
          </span>
          <button type="button" className="btn btn-secondary" disabled={!dirty || applying} onClick={revert}>
            되돌리기
          </button>
          <button type="button" className="btn btn-primary" disabled={!dirty || applying} onClick={() => void apply()}>
            적용
          </button>
        </div>
      </footer>

      {prohibitionsOpen && <ProhibitionsDialog onClose={() => setProhibitionsOpen(false)} />}
    </>
  );
}
