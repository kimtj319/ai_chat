import { useState } from "react";
import type { ConversationSummary } from "../api/types";
import { splitMatch } from "../state/conversationGroups";
import { CapabilityIcon } from "./CapabilityIcon";
import { EditIcon, PinIcon, TrashIcon } from "./icons";

interface ConversationRowProps {
  conversation: ConversationSummary;
  /** The search text; the matching part of the title is marked. */
  query: string;
  active: boolean;
  /** 이 대화에서 지금 답이 만들어지고 있으면 제목 옆에 작은 표시를 단다. */
  generating: boolean;
  /** One row is edited at a time, so the parent holds which. */
  editing: boolean;
  onSelect: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: () => void;
  onDelete: () => void;
}

/** 사이드바 목록의 대화 한 줄: 제목(검색어 표시), 이름 바꾸기 칸, 고정·이름 변경·삭제 단추. */
export function ConversationRow({
  conversation,
  query,
  active,
  generating,
  editing,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onRename,
  onTogglePin,
  onDelete,
}: ConversationRowProps) {
  const [editValue, setEditValue] = useState("");
  const match = splitMatch(conversation.title, query);
  const pinned = conversation.pinned === true;

  function startEditing() {
    setEditValue(conversation.title);
    onStartEdit();
  }

  // 줄 전체가 누르는 곳이지만(마우스), 키보드와 화면 읽기 프로그램이 닿는 것은 제목
  // 단추다. 단추에는 제 onClick 을 달지 않는다 — Enter·Space 가 만드는 click 이 줄까지
  // 올라와 같은 onSelect 를 한 번만 부른다.
  return (
    <div className={`sidebar-item${active ? " active" : ""}`} onClick={onSelect}>
      <CapabilityIcon kind={conversation.kind} className="sidebar-item-kind" />

      {editing ? (
        <input
          autoFocus
          className="sidebar-item-input"
          aria-label="대화 이름"
          value={editValue}
          onChange={(event) => setEditValue(event.target.value)}
          onBlur={() => onRename(conversation.id, editValue)}
          onKeyDown={(event) => {
            // 한글 조합 중의 Enter 는 글자를 맺는 키다 — 여기서 저장하면 마지막 글자가 빠지거나 겹친다.
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") onRename(conversation.id, editValue);
            if (event.key === "Escape") {
              // 전역 Esc(생성 중단)까지 가지 않게.
              event.nativeEvent.stopPropagation();
              onCancelEdit();
            }
          }}
          onClick={(event) => event.stopPropagation()}
        />
      ) : (
        <button
          type="button"
          className="sidebar-item-main"
          aria-current={active ? "page" : undefined}
          onDoubleClick={(event) => {
            event.stopPropagation();
            startEditing();
          }}
          data-tooltip={conversation.title}
        >
          <span className="sidebar-item-title">
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
          {generating && (
            <span className="sidebar-item-generating">
              <span className="visually-hidden"> · 답변 생성 중</span>
            </span>
          )}
        </button>
      )}

      <div className="sidebar-item-actions">
        <button
          type="button"
          className={`btn-icon${pinned ? " pinned" : ""}`}
          data-tooltip={pinned ? "고정 해제" : "고정"}
          aria-label={`「${conversation.title}」 대화 ${pinned ? "고정 해제" : "고정"}`}
          aria-pressed={pinned}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin();
          }}
        >
          <PinIcon />
        </button>
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
