import { useState } from "react";
import type { JsonSchemaNode, ToolDefinition } from "../api/types";
import { useDebouncedSave } from "../hooks/useDebouncedSave";
import { MISSING_KEY_NOTICE, missingKey, useMyAccess } from "../hooks/useMyAccess";
import { useTools } from "../hooks/useTools";
import { useActiveConversation, useStore } from "../state/StoreContext";
import type { ActiveConversation } from "../state/StoreContext";
import { categoryLabel, paramCopy, toolCopy, TYPE_LABELS } from "../state/toolCopy";
import { MasterDetail } from "./MasterDetail";
import { PageHeader } from "./PageHeader";
import { ToggleSwitch } from "./ToggleSwitch";
import "./ToolsPage.css";

function typeLabel(node: JsonSchemaNode): string {
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  if (types.length === 0) return "아무 형식";
  return types.map((t) => TYPE_LABELS[t] ?? t).join(" 또는 ");
}

/** Readable (not raw-JSON) rendering of a JSON-Schema-ish parameters object, one level of nesting deep. */
function SchemaFields({ tool, node, depth = 0, prefix = "" }: { tool: string; node: JsonSchemaNode; depth?: number; prefix?: string }) {
  const properties = node.properties;
  if (!properties || Object.keys(properties).length === 0) {
    return <p className="tool-schema-empty">매개변수 없음</p>;
  }
  const required = new Set(node.required ?? []);

  return (
    <ul className="tool-schema-list" style={{ paddingLeft: depth > 0 ? "var(--space-7)" : 0 }}>
      {Object.entries(properties).map(([name, field]) => (
        <li key={name} className="tool-schema-field">
          <div className="tool-schema-field-head">
            <code>{name}</code>
            <span className="tool-schema-type">{typeLabel(field)}</span>
            {required.has(name) && <span className="tool-schema-required">필수</span>}
          </div>
          {paramCopy(tool, `${prefix}${name}`, field.description) && (
            <p className="tool-schema-description">{paramCopy(tool, `${prefix}${name}`, field.description)}</p>
          )}
          {field.enum && <p className="tool-schema-enum">허용값: {field.enum.join(", ")}</p>}
          {field.type === "object" && field.properties && (
            <SchemaFields tool={tool} node={field} depth={depth + 1} prefix={`${prefix}${name}.`} />
          )}
          {field.type === "array" && field.items?.properties && (
            <SchemaFields tool={tool} node={field.items} depth={depth + 1} prefix={`${prefix}${name}[].`} />
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * 도구 설정 — 라이브러리·문서처럼 사이드바 옆 본문에 뜨는 화면. 켜고 끄는 것은 지금
 * 열린 대화의 도구 목록(enabledTools)이라, 다른 대화로 옮기면 그 대화의 것으로 바뀐다.
 */
export function ToolsPage({ onBack }: { onBack: () => void }) {
  const { activeConversation, activeConversationLoading } = useActiveConversation();
  return (
    <div className="tools-page">
      {activeConversation ? (
        // 대화가 바뀌면 고른 도구·저장 상태를 새로 시작한다.
        <ToolsPageBody key={activeConversation.id} conversation={activeConversation} onBack={onBack} />
      ) : (
        <>
          <ToolsHeader onBack={onBack} subtitle={activeConversationLoading ? "불러오는 중…" : "대화를 먼저 열면 그 대화의 도구를 고를 수 있습니다."} />
        </>
      )}
    </div>
  );
}

function ToolsHeader({ onBack, subtitle, status }: { onBack: () => void; subtitle: string; status?: "idle" | "saving" | "saved" | "error" }) {
  return (
    <PageHeader
      title="도구 설정"
      onBack={onBack}
      subtitle={
        <>
          {subtitle}
          {status === "saving" && <span className="tools-panel-saving"> · 저장 중…</span>}
          {status === "saved" && <span className="tools-panel-saved"> · 저장됨</span>}
          {status === "error" && <span className="tools-panel-error"> · 저장 실패</span>}
        </>
      }
    />
  );
}

function ToolsPageBody({ conversation, onBack }: { conversation: ActiveConversation; onBack: () => void }) {
  const { updateEnabledTools } = useStore();
  const { tools, loading, error } = useTools();
  const access = useMyAccess();
  const [enabledTools, setEnabledTools] = useState<string[]>(conversation.enabledTools);
  const [selected, setSelected] = useState<string | null>(null);
  const saveStatus = useDebouncedSave(enabledTools, updateEnabledTools, 400);

  function toggle(name: string) {
    setEnabledTools((current) => (current.includes(name) ? current.filter((t) => t !== name) : [...current, name]));
  }

  const categories = new Map<string, ToolDefinition[]>();
  for (const tool of tools) {
    const list = categories.get(tool.category) ?? [];
    list.push(tool);
    categories.set(tool.category, list);
  }
  // 처음 열면 첫 도구의 설명이 오른쪽에 보인다 — 빈 칸으로 시작하지 않는다.
  const shown = selected ?? tools[0]?.name ?? null;
  const onCount = tools.filter((t) => enabledTools.includes(t.name)).length;

  return (
    <>
      <ToolsHeader
        onBack={onBack}
        subtitle={loading ? "불러오는 중…" : `「${conversation.title || "새 대화"}」에서 켠 도구 ${onCount}개 / ${tools.length}개`}
        status={saveStatus}
      />
      <div className="tools-page-body">
        {error && <p className="message-error">{error}</p>}
        {tools.length > 0 && (
          <MasterDetail
            className="tools-master-detail"
            groups={[...categories.entries()].map(([category, items]) => ({ key: category, title: categoryLabel(category), items }))}
            idOf={(tool) => tool.name}
            selectedId={shown}
            onSelect={setSelected}
            renderRow={(tool) => (
              <>
                <span className="md-row-name">
                  <code className="tool-row-name">{tool.name}</code>
                  {missingKey(access, { tool: tool.name }) && (
                    <span className="md-badge" data-tone="warning">
                      키 필요
                    </span>
                  )}
                </span>
                <span className="md-row-desc">{toolCopy(tool).short}</span>
              </>
            )}
            renderTrailing={(tool) => (
              <ToggleSwitch on={enabledTools.includes(tool.name)} label={`${tool.name} 사용`} onToggle={() => toggle(tool.name)} />
            )}
            renderDetail={(tool) => (
              <ToolDetail tool={tool} keyMissing={missingKey(access, { tool: tool.name }) !== null} enabled={enabledTools.includes(tool.name)} />
            )}
            placeholder="왼쪽에서 도구를 고르면 자세한 설명이 여기에 보입니다."
          />
        )}
      </div>
    </>
  );
}

function ToolDetail({ tool, keyMissing, enabled }: { tool: ToolDefinition; keyMissing: boolean; enabled: boolean }) {
  const copy = toolCopy(tool);
  return (
    <div className="tool-detail">
      <div className="tool-detail-head">
        <code className="tool-detail-name">{tool.name}</code>
        <span className="md-badge">{enabled ? "이 대화에서 켜짐" : "꺼짐"}</span>
      </div>
      <p className="tool-detail-short">{copy.short}</p>
      {keyMissing && (
        <p className="tool-detail-warning" role="note">
          {MISSING_KEY_NOTICE}
        </p>
      )}
      <p className="tool-detail-long">{copy.long}</p>
      <p className="tool-schema-heading">매개변수</p>
      <SchemaFields tool={tool.name} node={tool.parameters} />
    </div>
  );
}
