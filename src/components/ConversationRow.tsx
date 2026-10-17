import { useState } from "react";
import type { ConversationSummary } from "../api/types";
import { splitMatch } from "../state/conversationGroups";
import { CapabilityIcon } from "./CapabilityIcon";
import { EditIcon, TrashIcon } from "./icons";

interface ConversationRowProps {
  conversation: ConversationSummary;
  /** The search text; the matching part of the title is marked. */
  query: string;
  active: boolean;
  /** One row is edited at a time, so the parent holds which. */
  editing: boolean;
  onSelect: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: () => void;
}

/** 사이드바 목록의 대화 한 줄: 제목(검색어 표시), 이름 바꾸기 칸, 이름 변경·삭제 단추. */
export function ConversationRow({
  conversation,
  query,
  active,
  editing,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onRename,
  onDelete,
}: ConversationRowProps) {
  const [editValue, setEditValue] = useState("");
  const match = splitMatch(conversation.title, query);

  function startEditing() {
    setEditValue(conversation.title);
    onStartEdit();
  }

  return (
    <div className={`sidebar-item${active ? " active" : ""}`} onClick={onSelect}>
      <CapabilityIcon kind={conversation.kind} className="sidebar-item-kind" />

      {editing ? (
        <input
          autoFocus
          className="sidebar-item-input"
          value={editValue}
          onChange={(event) => setEditValue(event.target.value)}
          onBlur={() => onRename(conversation.id, editValue)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onRename(conversation.id, editValue);
            if (event.key === "Escape") onCancelEdit();
          }}
          onClick={(event) => event.stopPropagation()}
        />
      ) : (
        <span
          className="sidebar-item-title"
          onDoubleClick={(event) => {
            event.stopPropagation();
            startEditing();
          }}
          data-tooltip={conversation.title}
        >
          {match ? (
            <>
              {match[0]}
              <mark className="sidebar-item-match">{match[1]}</mark>
              {match[2]}
            </>
          ) : (
            conversation.title
          )}
        </span>
      )}

      <div className="sidebar-item-actions">
        <button
          type="button"
          className="btn-icon"
          data-tooltip="이름 변경"
          aria-label={`「${conversation.title}」 대화 이름 변경`}
          onClick={(event) => {
            event.stopPropagation();
            startEditing();
          }}
        >
          <EditIcon />
        </button>
        <button
          type="button"
          className="btn-icon"
          data-tooltip="삭제"
          aria-label={`「${conversation.title}」 대화 삭제`}
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  );
}
