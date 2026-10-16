import { useId, useMemo, useState } from "react";

/**
 * 서버가 내주는 모델 중 쓸 것만 고르는 목록. OpenRouter 처럼 수백 개를 내주는 서버에서
 * 쓰라고 만들었다 — 고르지 않은 모델은 탐침되지도, 모델 선택란에 오르지도 않는다.
 * 고른 것이 없으면 "전부" 다(mustChoose 면 그럴 수 없다).
 */
export function ModelChooser({
  models,
  chosen,
  mustChoose,
  onChange,
}: {
  models: string[];
  chosen: string[];
  mustChoose: boolean;
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const picked = useMemo(() => new Set(chosen), [chosen]);
  const needle = query.trim().toLowerCase();
  const visible = needle ? models.filter((m) => m.toLowerCase().includes(needle)) : models;
  // 고른 것을 위로: 수백 개 중 무엇을 골랐는지 스크롤하지 않고 보이게.
  const ordered = [...visible.filter((m) => picked.has(m)), ...visible.filter((m) => !picked.has(m))];

  function toggle(id: string) {
    onChange(picked.has(id) ? chosen.filter((m) => m !== id) : [...chosen, id]);
  }

  return (
    <div className="model-chooser">
      <div className="model-chooser-head">
        <label className="visually-hidden" htmlFor={searchId}>
          모델 검색
        </label>
        <input
          id={searchId}
          type="search"
          className="model-chooser-search"
          placeholder={`모델 ${models.length}개 중 검색 (예: claude, gpt, :free)`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="model-chooser-link"
          disabled={visible.length === 0}
          onClick={() => onChange([...new Set([...chosen, ...visible])])}
        >
          {needle ? `찾은 ${visible.length}개 선택` : "모두 선택"}
        </button>
        <button type="button" className="model-chooser-link" disabled={chosen.length === 0} onClick={() => onChange([])}>
          선택 해제
        </button>
      </div>
      <p className="model-chooser-count" role="status">
        {chosen.length > 0
          ? `${models.length}개 중 ${chosen.length}개 선택 — 고른 모델만 목록에 오르고 확인 요청을 받습니다.`
          : mustChoose
            ? `모델이 ${models.length}개라 쓸 모델을 골라야 합니다.`
            : "고르지 않으면 모든 모델을 씁니다."}
      </p>
      <ul className="model-chooser-list">
        {ordered.map((id) => (
          <li key={id}>
            <label className="model-chooser-row">
              <input type="checkbox" checked={picked.has(id)} onChange={() => toggle(id)} />
              <span>{id}</span>
            </label>
          </li>
        ))}
        {ordered.length === 0 && <li className="model-chooser-empty">맞는 모델이 없습니다.</li>}
      </ul>
    </div>
  );
}
