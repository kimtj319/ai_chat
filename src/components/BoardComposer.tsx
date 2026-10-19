import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api/client";
import type { BoardPostView } from "../api/types";
import { hueOf } from "../state/boardFormat";
import { errorMessage } from "../state/friendlyError";
import { isSubmitChord, Label, MAX_BODY_CHARS, MAX_TAGS, MAX_TITLE_CHARS, PlainTextField, ref } from "./boardParts";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";

/* ------------------------------------------------------- 새 글 쓰기·고치기 */

interface BoardComposerProps {
  /** 있으면 이 글을 고친다. 쓸 때와 같은 칸을 쓴다. */
  editing?: BoardPostView;
  knownTags: string[];
  onCancel: () => void;
  onDone: (post: BoardPostView) => void;
  onError: (message: string) => void;
}

export function BoardComposer({ editing, knownTags, onCancel, onDone, onError }: BoardComposerProps) {
  const initial = useMemo(
    () => ({ title: editing?.title ?? "", body: editing?.body ?? "", tagText: editing?.tags.join(", ") ?? "" }),
    [editing],
  );
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [tagText, setTagText] = useState(initial.tagText);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  /** 쉼표로 가른다. 정리는 서버가 한 번 더 하므로 여기서는 보여 주기만 한다. */
  const typedTags = useMemo(
    () => [
      ...new Set(
        tagText
          .split(",")
          .map((t) => t.trim().toLowerCase().replace(/\s+/g, "-").replace(/^#+/, ""))
          .filter(Boolean),
      ),
    ],
    [tagText],
  );
  const tags = typedTags.slice(0, MAX_TAGS);
  const dropped = typedTags.length - tags.length;

  // 고칠 때는 처음 연 모습과 달라졌는지를 본다 — 열자마자 닫아도 묻지 않게.
  const dirty = title.trim() !== initial.title.trim() || body.trim() !== initial.body.trim() || tagText.trim() !== initial.tagText.trim();

  /** 바깥을 눌렀든 Esc 를 눌렀든 여기를 지난다 — 적어 둔 것이 말없이 사라지지 않게. */
  function requestClose(): void {
    if (saving) return;
    if (dirty) setConfirmDiscard(true);
    else onCancel();
  }

  function addTag(tag: string): void {
    if (tags.includes(tag) || tags.length >= MAX_TAGS) return;
    setTagText(tagText.trim() ? `${tagText.replace(/,\s*$/, "")}, ${tag}` : tag);
  }

  async function submit() {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      const input = { title: title.trim(), body: body.trim(), tags };
      const saved = editing ? await api.editBoardPost(editing.id, input) : await api.createBoardPost(input);
      onDone(saved.post);
    } catch (err) {
      onError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <>
      <Modal title={editing ? `문의 수정 ${ref(editing.number)}`.trim() : "새 문의"} onClose={requestClose} width={560}>
        <div className="board-compose">
          <label className="board-field">
            <span className="board-field-label">제목</span>
            <input
              ref={titleRef}
              className="board-input"
              value={title}
              maxLength={MAX_TITLE_CHARS}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                // 한 줄짜리 칸에서 Enter 는 제출 말고 할 일이 없다.
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="무엇이 궁금한가요?"
            />
          </label>

          <div className="board-field">
            <label className="board-field-label" htmlFor="board-compose-body">
              내용
              {body.length > MAX_BODY_CHARS * 0.9 && (
                <span className="board-field-count">
                  {body.length.toLocaleString()} / {MAX_BODY_CHARS.toLocaleString()}자
                </span>
              )}
            </label>
            <PlainTextField
              id="board-compose-body"
              className="board-input board-textarea"
              rows={7}
              maxLength={MAX_BODY_CHARS}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (isSubmitChord(e)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="상황과 재현 방법을 적어 주시면 답하기 쉽습니다."
            />
          </div>

          <label className="board-field">
            <span className="board-field-label">라벨 (쉼표로 구분, 최대 {MAX_TAGS}개)</span>
            <input
              className="board-input"
              value={tagText}
              onChange={(e) => setTagText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="예: 검색, 색인, 오류"
            />
          </label>

          {tags.length > 0 && (
            <div className="board-tagbar">
              {tags.map((t) => (
                <Label key={t} name={t} />
              ))}
            </div>
          )}
          {/* 아홉 번째 태그를 조용히 버리지 않는다. */}
          {dropped > 0 && (
            <p className="board-field-warn">
              라벨은 {MAX_TAGS}개까지입니다. 뒤의 {dropped}개는 빠집니다.
            </p>
          )}

          {knownTags.length > 0 && (
            <>
              <p className="board-field-label">이미 쓰이는 라벨</p>
              <div className="board-tagbar">
                {knownTags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="board-label board-label-filter"
                    style={{ "--label-hue": hueOf(t) } as React.CSSProperties}
                    disabled={tags.length >= MAX_TAGS && !tags.includes(t)}
                    onClick={() => addTag(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="board-compose-actions">
            <button type="button" className="btn btn-secondary" onClick={requestClose} disabled={saving}>
              취소
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={saving || !title.trim()}>
              {editing ? (saving ? "저장하는 중…" : "저장") : saving ? "올리는 중…" : "올리기"}
            </button>
          </div>
        </div>
      </Modal>

      {confirmDiscard && (
        <ConfirmDialog
          title={editing ? "고치던 내용을 버릴까요?" : "쓰던 글을 버릴까요?"}
          message={editing ? "고친 내용이 사라지고 글은 그대로 남습니다." : "적어 둔 내용이 사라집니다."}
          confirmLabel="버리기"
          danger
          onConfirm={onCancel}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </>
  );
}
