import { useCallback, useEffect, useState, type FormEvent } from "react";
import * as api from "../api/client";
import type { MyAccess, PersonalKeyName } from "../api/types";
import { Modal } from "./Modal";
import "./PersonalKeysDialog.css";

/**
 * 개인 키: 웹 검색(Tavily)·wisenut 이슈(GitLab)·Alpha Vantage 를 본인 키로 쓰기 위한 화면.
 *
 * 공용 키를 쓸 수 있는 계정(auth/privilege.ts)은 등록하지 않아도 되고, 등록하면
 * 본인 키가 먼저 쓰인다. 그 밖의 계정은 여기서 등록해야 그 기능이 동작한다.
 * 화면 문구는 모두에게 같다 — 어느 팀이 공용 키를 쓰는지는 알리지 않는다.
 * 서버는 키 값을 돌려주지 않는다 — 등록 여부와 끝 네 자리만 보인다.
 */
const KEYS: Array<{ name: PersonalKeyName; title: string; what: string; how: string }> = [
  {
    name: "tavily",
    title: "웹 검색 API 키 (Tavily)",
    what: "web_search 도구가 이 키로 검색합니다.",
    how: "app.tavily.com 에 가입하면 무료 키(tvly-…)를 받을 수 있습니다.",
  },
  {
    name: "gitlab",
    title: "GitLab 토큰 (wisenut 이슈)",
    what: "wisenut 이슈 MCP 가 이 토큰으로 GitLab 이슈를 읽습니다. 토큰으로 볼 수 있는 이슈만 검색됩니다.",
    how: "GitLab › 사용자 설정 › 액세스 토큰에서 read_api 권한으로 발급하세요.",
  },
  {
    name: "alphavantage",
    title: "Alpha Vantage API 키 (주식·환율)",
    what: "Alpha Vantage MCP 가 이 키로 시세·재무 데이터를 조회합니다.",
    how: "alphavantage.co › Get Free API Key 에서 받을 수 있습니다.",
  },
];

export function PersonalKeysDialog({ onClose }: { onClose: () => void }) {
  const [access, setAccess] = useState<MyAccess | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAccess(await api.getMyAccess());
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Modal title="개인 키" onClose={onClose} width={480}>
      {access && (
        <p className="keys-scope" role="note">
          등록한 키는 이 계정의 웹 검색·wisenut 이슈·Alpha Vantage 호출에만 쓰이며, 저장한 뒤에는 다시 보여 주지 않습니다.
        </p>
      )}
      {loadError && <p className="message-error">{loadError}</p>}
      {!access && !loadError && <p className="keys-scope">불러오는 중…</p>}
      {access &&
        KEYS.map((key) => (
          <KeyRow
            key={key.name}
            spec={key}
            state={access.keys[key.name]}
            onChange={(keys) => setAccess({ ...access, keys })}
          />
        ))}
    </Modal>
  );
}

function KeyRow({
  spec,
  state,
  onChange,
}: {
  spec: (typeof KEYS)[number];
  state: MyAccess["keys"][PersonalKeyName];
  onChange: (keys: MyAccess["keys"]) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || value.trim().length === 0) return;
    setBusy(true);
    try {
      onChange((await api.setPersonalKey(spec.name, value.trim())).keys);
      setValue("");
      setMessage({ tone: "ok", text: "저장했습니다." });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      onChange((await api.deletePersonalKey(spec.name)).keys);
      setMessage({ tone: "ok", text: "삭제했습니다." });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const inputId = `personal-key-${spec.name}`;
  return (
    <form className="keys-row" onSubmit={(event) => void save(event)}>
      <div className="keys-row-head">
        <label htmlFor={inputId} className="keys-row-title">
          {spec.title}
        </label>
        <span className="keys-row-state" data-set={state.set ? "true" : "false"}>
          {state.set ? `등록됨 ${state.hint ?? ""}` : "등록 안 됨"}
        </span>
      </div>
      <p className="keys-row-hint">
        {spec.what} {spec.how}
      </p>
      <div className="field keys-row-input">
        <input
          id={inputId}
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={state.set ? "새 키로 바꾸려면 입력" : "키를 붙여 넣으세요"}
          autoComplete="new-password"
          spellCheck={false}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || value.trim().length === 0}>
          저장
        </button>
        {state.set && (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void remove()}>
            삭제
          </button>
        )}
      </div>
      {message && (
        <p className="keys-row-message" role="status" data-tone={message.tone}>
          {message.text}
        </p>
      )}
    </form>
  );
}
