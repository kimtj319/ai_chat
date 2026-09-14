import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { pushOverlay } from "../ui/overlayStack";
import { useAuth } from "../auth/AuthContext";
import { useDebouncedSave } from "../hooks/useDebouncedSave";
import { useMcpLibrary } from "../hooks/useMcpLibrary";
import {
  isMcpToolName,
  mergeMcpSelection,
  myLibrary,
  sameTools,
  selectionState,
  shortToolName,
  type SelectionState,
} from "../mcp/rules";
import type { McpServerSummary, McpToolSummary } from "../api/types";
import type { ActiveConversation } from "../state/StoreContext";
import { useStore } from "../state/StoreContext";
import "./McpPicker.css";

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** A checkbox with the third state a browser cannot express in markup. */
function TriStateCheckbox({
  state,
  disabled,
  label,
  onChange,
}: {
  state: SelectionState;
  disabled?: boolean;
  label: string;
  onChange: (on: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === "all"}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

interface VisibleServer {
  server: McpServerSummary;
  /** Under a query, only the tools that matched; otherwise the whole list. */
  tools: McpToolSummary[];
  forcedOpen: boolean;
}

/**
 * The list the query leaves behind. A server whose own name matched keeps its
 * whole tool list and its collapsed state — the user named the server, not
 * something inside it. A server reached only through a tool shows just the
 * matching tools and opens itself, because the thing that was searched for is
 * exactly what a closed row would hide.
 */
function visibleServers(servers: McpServerSummary[], query: string): VisibleServer[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return servers.map((server) => ({ server, tools: server.tools, forcedOpen: false }));

  const visible: VisibleServer[] = [];
  for (const server of servers) {
    // The server's own description counts as naming it. Every server here is
    // described in Korean while the tools it ships describe themselves in
    // English, so without this a reader searching "주가" — the word actually
    // in Alpha Vantage's description — gets nothing back.
    if (
      server.name.toLowerCase().includes(needle) ||
      server.description.toLowerCase().includes(needle)
    ) {
      visible.push({ server, tools: server.tools, forcedOpen: false });
      continue;
    }
    // The description is searched too: the short name is often an abbreviation
    // ("TIME_SERIES_DAILY"), and the sentence beside it is where the word the
    // user actually has in mind ("주가") lives.
    const tools = server.tools.filter(
      (tool) =>
        shortToolName(tool.name).toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle),
    );
    if (tools.length > 0) visible.push({ server, tools, forcedOpen: true });
  }
  return visible;
}

interface McpPickerProps {
  conversation: ActiveConversation;
  onOpenLibrary: () => void;
}

/**
 * The composer's plus button: which MCP tools are live in THIS conversation.
 *
 * It writes the same `conversation.enabledTools` array the 도구 설정 panel
 * writes, with the same debounce — the two are two views of one list, not two
 * mechanisms. The builtin tools are deliberately absent: that list is 24 items
 * long and belongs to 도구 설정.
 *
 * Servers arrive collapsed, and a search sits above them, because switching a
 * whole server on is the common case and picking single tools is the
 * exception: one server that ships 11 tools would otherwise bury the other
 * three in a scroll.
 */
export function McpPicker({ conversation, onOpenLibrary }: McpPickerProps) {
  const { updateEnabledTools } = useStore();
  const { me } = useAuth();
  const { servers, adopted, optedOutBuiltins, loading, unavailable } = useMcpLibrary();
  const [open, setOpen] = useState(false);

  // 열려 있는 동안은 Esc 가 이쪽 몫이다 — 전역 Esc(생성 중단)와 겹치지 않게.
  useEffect(() => (open ? pushOverlay() : undefined), [open]);
  const [query, setQuery] = useState("");
  const [expandedServers, setExpandedServers] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchId = useId();

  const [selected, setSelected] = useState<string[]>(() => conversation.enabledTools.filter(isMcpToolName));

  // Composed against whatever is stored at save time rather than against a copy
  // taken when the picker opened: that is what stops this and 도구 설정 from
  // overwriting each other's half of the array.
  const saveStatus = useDebouncedSave(
    selected,
    (names) => {
      const next = mergeMcpSelection(conversation.enabledTools, names);
      if (sameTools(next, conversation.enabledTools)) return Promise.resolve();
      return updateEnabledTools(next);
    },
    400,
  );

  // Another conversation opened underneath the picker. Keyed on the id alone:
  // seeding from the array itself would re-fire on the PATCH's own response.
  useEffect(() => {
    setSelected(conversation.enabledTools.filter(isMcpToolName));
  }, [conversation.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (event.key === "ArrowUp" && !open) {
      event.preventDefault();
      setOpen(true);
    }
  }

  function toggleTool(name: string) {
    setSelected((current) => (current.includes(name) ? current.filter((tool) => tool !== name) : [...current, name]));
  }

  function toggleServer(toolNames: string[], on: boolean) {
    setSelected((current) => {
      const without = current.filter((name) => !toolNames.includes(name));
      return on ? [...without, ...toolNames] : without;
    });
  }

  function toggleExpanded(id: string) {
    setExpandedServers((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  }

  // Only what this user adopted: a server someone else registered has nothing
  // to offer here until it has been taken into the library.
  const mine = myLibrary(servers, adopted, optedOutBuiltins, me?.id ?? "");
  const enabled = new Set(selected);
  const visible = visibleServers(mine, query);

  return (
    <div className="mcp-picker" ref={containerRef}>
      <button
        type="button"
        className="btn-icon mcp-picker-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        data-tooltip="MCP 도구 선택"
        aria-label="MCP 도구 선택"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={handleTriggerKeyDown}
      >
        <PlusIcon />
        {selected.length > 0 && <span className="mcp-picker-count">{selected.length}</span>}
      </button>

      {open && (
        <div className="mcp-picker-popover" aria-label="MCP 도구">
          <div className="mcp-picker-head">
            <p className="mcp-picker-title">MCP 도구</p>
            {saveStatus === "saving" && <span className="mcp-picker-status">저장 중…</span>}
            {saveStatus === "saved" && <span className="mcp-picker-status saved">저장됨</span>}
            {saveStatus === "error" && <span className="mcp-picker-status error">저장 실패</span>}
          </div>

          {/* Nothing to narrow while the library is loading, missing or empty. */}
          {!loading && !unavailable && mine.length > 0 && (
            <>
              <label className="visually-hidden" htmlFor={searchId}>
                서버·도구 검색
              </label>
              <input
                id={searchId}
                type="search"
                className="mcp-picker-search"
                placeholder="서버·도구 검색"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </>
          )}

          <div className="mcp-picker-list">
            {loading ? (
              <p className="mcp-picker-empty">불러오는 중…</p>
            ) : unavailable ? (
              <p className="mcp-picker-empty">이 서버에는 아직 MCP 기능이 배포되지 않았습니다.</p>
            ) : mine.length === 0 ? (
              <p className="mcp-picker-empty">내 라이브러리가 비어 있습니다. 라이브러리에서 서버를 추가해보세요.</p>
            ) : visible.length === 0 ? (
              <p className="mcp-picker-empty">검색 결과가 없습니다.</p>
            ) : (
              visible.map(({ server, tools, forcedOpen }) => {
                const toolNames = server.tools.map((tool) => tool.name);
                const state = selectionState(toolNames, enabled);
                const off = server.status === "disabled";
                const expanded = forcedOpen || expandedServers.includes(server.id);
                return (
                  <section key={server.id} className="mcp-picker-server">
                    {/* Two sibling controls, not a label around both: ticking the
                        box must not open the row, and opening the row must not
                        tick the box. While a query is holding the row open the
                        expander only records what to do once it is cleared. */}
                    <div className="mcp-picker-row">
                      <TriStateCheckbox
                        state={state}
                        disabled={off || toolNames.length === 0}
                        label={`${server.name} 전체 사용`}
                        onChange={(on) => toggleServer(toolNames, on)}
                      />
                      <button
                        type="button"
                        className="mcp-picker-disclosure"
                        aria-expanded={expanded}
                        aria-label={`${server.name} 도구 목록`}
                        onClick={() => toggleExpanded(server.id)}
                      >
                        <span className="mcp-picker-server-name">{server.name}</span>
                        <span className="mcp-picker-server-count">{toolNames.length}</span>
                        <span className={`mcp-picker-chevron${expanded ? " open" : ""}`}>
                          <ChevronIcon />
                        </span>
                      </button>
                    </div>

                    {off && <p className="mcp-picker-note">관리자가 비활성화한 서버입니다.</p>}
                    {server.requiresCredential && !server.hasCredential && (
                      <p className="mcp-picker-note">자격 증명을 입력해야 실행됩니다.</p>
                    )}

                    {expanded &&
                      tools.map((tool) => (
                        <label key={tool.name} className="mcp-picker-row mcp-picker-tool">
                          <input
                            type="checkbox"
                            checked={enabled.has(tool.name)}
                            disabled={off}
                            onChange={() => toggleTool(tool.name)}
                          />
                          <span data-tooltip={tool.description}>{shortToolName(tool.name)}</span>
                        </label>
                      ))}
                  </section>
                );
              })
            )}
          </div>

          {/* Collapsed rows hide which tools are on, so the count is stated. */}
          <div className="mcp-picker-foot">
            <span>{selected.length > 0 ? `도구 ${selected.length}개 선택됨` : "선택한 도구 없음"}</span>
            {selected.length > 0 && (
              <button type="button" className="mcp-picker-clear" onClick={() => setSelected([])}>
                모두 해제
              </button>
            )}
          </div>

          <button
            type="button"
            className="mcp-picker-link"
            onClick={() => {
              setOpen(false);
              onOpenLibrary();
            }}
          >
            라이브러리에서 서버 관리
          </button>
        </div>
      )}
    </div>
  );
}
