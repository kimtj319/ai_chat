import { useEffect, useState } from "react";
import { getProhibitions } from "../api/client";
import type { ConversationSettings } from "../api/types";
import { useDebouncedSave } from "../hooks/useDebouncedSave";
import { MAX_MAX_TOKENS, MIN_MAX_TOKENS } from "../state/defaults";
import type { ActiveConversation } from "../state/StoreContext";
import { useStore } from "../state/StoreContext";
import { Modal } from "./Modal";
import { ProhibitionsDialog } from "./ProhibitionsDialog";
import "./ConversationSettingsPanel.css";

interface ConversationSettingsPanelProps {
  conversation: ActiveConversation;
  onClose: () => void;
}

function SaveIndicator({ status }: { status: "idle" | "saving" | "saved" | "error" }) {
  if (status === "idle") return null;
  return (
    <span className={`save-indicator save-indicator-${status}`}>
      {status === "saving" ? "저장 중…" : status === "saved" ? "저장됨" : "저장 실패"}
    </span>
  );
}

export function ConversationSettingsPanel({ conversation, onClose }: ConversationSettingsPanelProps) {
  const { updateSystemPrompt, updateSettings } = useStore();
  const [systemPrompt, setSystemPrompt] = useState(conversation.systemPrompt);
  const [settings, setSettings] = useState<ConversationSettings>(conversation.settings);

  const systemPromptStatus = useDebouncedSave(systemPrompt, updateSystemPrompt);
  const settingsStatus = useDebouncedSave(settings, updateSettings);

  function patchSampling(patch: Partial<ConversationSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
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
    <Modal title="대화 설정" onClose={prohibitionsOpen ? () => setProhibitionsOpen(false) : onClose} width={560}>
      <div className="field">
        <label htmlFor="system-prompt">
          시스템 프롬프트 (이 대화에만 적용) <SaveIndicator status={systemPromptStatus} />
        </label>
        <textarea
          id="system-prompt"
          rows={5}
          value={systemPrompt}
          onChange={(event) => setSystemPrompt(event.target.value)}
          placeholder="예: 당신은 친절한 한국어 코딩 어시스턴트입니다."
        />
      </div>

      <h3 className="panel-subheading">
        샘플링 파라미터 <SaveIndicator status={settingsStatus} />
      </h3>

      <div className="param-grid">
        <div className="field">
          <label htmlFor="param-temperature">Temperature ({settings.temperature.toFixed(2)})</label>
          <input
            id="param-temperature"
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={settings.temperature}
            onChange={(event) => patchSampling({ temperature: Number(event.target.value) })}
          />
        </div>

        <div className="field">
          <label htmlFor="param-top-p">Top P ({settings.topP.toFixed(2)})</label>
          <input
            id="param-top-p"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={settings.topP}
            onChange={(event) => patchSampling({ topP: Number(event.target.value) })}
          />
        </div>

        <div className="field">
          <label htmlFor="param-frequency">Frequency Penalty ({settings.frequencyPenalty.toFixed(2)})</label>
          <input
            id="param-frequency"
            type="range"
            min={-2}
            max={2}
            step={0.1}
            value={settings.frequencyPenalty}
            onChange={(event) => patchSampling({ frequencyPenalty: Number(event.target.value) })}
          />
        </div>

        <div className="field">
          <label htmlFor="param-presence">Presence Penalty ({settings.presencePenalty.toFixed(2)})</label>
          <input
            id="param-presence"
            type="range"
            min={-2}
            max={2}
            step={0.1}
            value={settings.presencePenalty}
            onChange={(event) => patchSampling({ presencePenalty: Number(event.target.value) })}
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
            value={settings.maxTokens}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (!Number.isNaN(value)) patchSampling({ maxTokens: value });
            }}
          />
        </div>

        <div className="field">
          <label htmlFor="param-seed">Seed (선택)</label>
          <input
            id="param-seed"
            type="number"
            placeholder="비워두면 무작위"
            value={settings.seed ?? ""}
            onChange={(event) => {
              const raw = event.target.value;
              patchSampling({ seed: raw.trim().length === 0 ? null : Number(raw) });
            }}
          />
        </div>
      </div>

      <h3 className="panel-subheading">하지 말 것 목록</h3>
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

      {prohibitionsOpen && <ProhibitionsDialog onClose={() => setProhibitionsOpen(false)} />}
    </Modal>
  );
}
