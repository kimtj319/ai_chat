import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from "react";
import type { ConversationKind, ReasoningLevel, ReasoningMode } from "../api/types";
import { attachmentTotal, draftOverBudget, WAITING_FOR_UPLOAD } from "../attachments/messages";
import { useDebouncedSave } from "../hooks/useDebouncedSave";
import { useMediaQuery } from "../hooks/useMediaQuery";
import type { AttachmentDraft, DraftAttachment } from "../hooks/useAttachmentDraft";
import { composerKeyHint, composerPlaceholder, EMBEDDING_MODE_NOTICE } from "../state/modelCapability";
import type { ActiveConversation } from "../state/StoreContext";
import { useStore } from "../state/StoreContext";
import { AttachmentChip } from "./AttachmentChip";
import { AttachmentPreview, type PreviewTarget } from "./AttachmentPreview";
import { McpPicker } from "./McpPicker";
import { ReasoningControl } from "./ReasoningControl";
import { BrowserControlToggle, useBrowserControlActive } from "./BrowserControlToggle";
import { PaperclipIcon } from "./icons";
import "./Composer.css";

/** Match .composer-textarea's min/max-height in Composer.css. */
const MIN_COMPOSER_HEIGHT = 40;
const MAX_COMPOSER_HEIGHT = 220;

const COMPACTING_PLACEHOLDER = "컨텍스트를 압축하는 중입니다. 끝나면 다시 입력할 수 있습니다.";

/** Past this share of the per-message budget the total stops being neutral. */
const WARN_SHARE = 0.3;

interface ComposerProps {
  conversation: ActiveConversation;
  /** What this turn will do: answer the text, or embed it. */
  kind: ConversationKind;
  /** Whether this conversation's model ignores the reasoning controls. */
  reasoningFixed: boolean;
  isStreaming: boolean;
  /** 컨텍스트 압축 중 — 입력과 보내기를 막는다. 끝나면 풀린다. */
  compacting: boolean;
  attachments: AttachmentDraft;
  onSend: (text: string, attachmentIds: string[]) => void;
  onStop: () => void;
  /** Where the MCP picker's footer link goes. */
  onOpenLibrary: () => void;
  onOpenTools?: () => void;
  /** 빈 대화에서 입력창 아래에 시작 칩을 보인다. */
  showStarters?: boolean;
}

/* 시작 칩: 누르면 입력창을 채우고 커서를 끝에 둘 뿐, 절대 저절로 보내지 않는다 —
   무엇을 물을지는 사용자가 이어 쓴다. "파일" 은 채우는 대신 파일 고르기를 연다.
   wideOnly 는 폰에서 숨긴다(App.css): 넷이면 폰에서 두 줄로 쌓여 입력창 아래를 무겁게
   했다. "파일 올려서 묻기" 는 클립 단추와 같은 일이고, "표로 정리하기" 는 문장을 채울 뿐이다. */
type Starter = { label: string; wideOnly?: true } & ({ text: string } | { pickFile: true });
const STARTERS: Starter[] = [
  { label: "사내 문서에서 찾기", text: "올린 문서에서 " },
  { label: "표로 정리하기", text: "다음 내용을 표로 정리해 줘: ", wideOnly: true },
  { label: "파일 올려서 묻기", pickFile: true, wideOnly: true },
  { label: "웹에서 찾아보기", text: "웹에서 찾아서 알려 줘: " },
];

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function previewTargetFor(item: DraftAttachment): PreviewTarget | null {
  if (item.kind === "image") {
    return item.previewUrl ? { kind: "image", name: item.name, src: item.previewUrl } : null;
  }
  return { kind: "text", name: item.name, text: item.text ?? "" };
}

export function Composer({
  conversation,
  kind,
  reasoningFixed,
  isStreaming,
  compacting,
  attachments,
  onSend,
  onStop,
  onOpenLibrary,
  onOpenTools,
  showStarters = false,
}: ComposerProps) {
  const { updateSettings, setLastReasoning, setLastReasoningMode } = useStore();
  // 손가락으로 쓰는 화면: Shift 가 없으니 Enter 는 줄바꿈, 보내기는 단추(handleKeyDown).
  const touch = useMediaQuery("(pointer: coarse)");
  const [text, setText] = useState("");
  const [budget, setBudget] = useState(conversation.settings.thinkingTokenBudget);
  // Enter pressed while an upload is still running: the text is frozen and the
  // turn goes out by itself once every upload has settled.
  const [pendingSubmit, setPendingSubmit] = useState(false);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Grow with the content up to MAX_COMPOSER_HEIGHT, then stop and let the
  // textarea scroll internally — the composer must never push the transcript
  // off the screen. Height is reset to "auto" first so it can also shrink.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Never below MIN so a single line lines up with the 40px send button.
    const next = Math.min(Math.max(el.scrollHeight, MIN_COMPOSER_HEIGHT), MAX_COMPOSER_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_COMPOSER_HEIGHT ? "auto" : "hidden";
  }, [text]);

  // The reasoning budget slider is local (for smooth dragging) and re-synced
  // whenever the active conversation changes underneath it.
  useEffect(() => {
    setBudget(conversation.settings.thinkingTokenBudget);
  }, [conversation.id, conversation.settings.thinkingTokenBudget]);

  useDebouncedSave(budget, (value) => {
    if (value === conversation.settings.thinkingTokenBudget) return Promise.resolve();
    setLastReasoning(conversation.settings.reasoningLevel, value);
    return updateSettings({ ...conversation.settings, thinkingTokenBudget: value });
  });

  function handleLevelChange(level: ReasoningLevel) {
    setLastReasoning(level, budget);
    void updateSettings({ ...conversation.settings, reasoningLevel: level });
  }

  function handleModeChange(mode: ReasoningMode) {
    setLastReasoningMode(mode);
    void updateSettings({ ...conversation.settings, reasoningMode: mode });
  }

  const { items, hasPending, hasFailed, overBudget, totalTokens, limits } = attachments;
  const hasAttachments = items.length > 0;
  // An image with no text is a perfectly good turn, so text alone no longer
  // gates the send button — but an over-budget draft does.
  const canSend = (text.trim().length > 0 || hasAttachments) && !overBudget;

  function dispatch() {
    onSend(text.trim(), attachments.readyIds());
    setText("");
    // Revokes every object URL the draft owned.
    attachments.clear();
    textareaRef.current?.focus();
  }

  function submit() {
    if (isStreaming || compacting || !canSend) return;
    if (hasFailed) {
      attachments.reportSubmitBlocked();
      return;
    }
    if (hasPending) {
      setPendingSubmit(true);
      return;
    }
    dispatch();
  }

  // The queued send: fires when the last upload settles, and never sends a
  // partial set — one failure cancels the queue and keeps the text and chips.
  useEffect(() => {
    if (!pendingSubmit || hasPending) return;
    setPendingSubmit(false);
    if (hasFailed || overBudget) {
      attachments.reportSubmitBlocked();
      return;
    }
    dispatch();
    // `dispatch` reads `text`, which is frozen (readOnly) while pendingSubmit
    // is set, so this deliberately does not re-run on every keystroke.
  }, [pendingSubmit, hasPending, hasFailed, overBudget]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (pendingSubmit && event.key === "Escape") {
      event.preventDefault();
      setPendingSubmit(false);
      return;
    }
    // 한글을 조합하는 중의 Enter 는 글자를 끝내는 것이지 보내라는 것이 아니다.
    // 이것을 보내기로 받으면 마지막 글자가 빠지거나 두 번 들어간 채 전송된다.
    if (event.nativeEvent.isComposing) return;
    // 폰·태블릿에는 Shift 가 없으니 Enter 는 줄바꿈으로 두고, 보내기는 단추로 한다.
    if (touch) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    // A copy out of a spreadsheet carries both a bitmap and its text. Only an
    // image-only clipboard may swallow the paste, or pasting a cell range
    // would silently stop inserting text.
    const hasPlainText = event.clipboardData.getData("text/plain").length > 0;
    if (!hasPlainText) event.preventDefault();
    attachments.addFiles(files, "paste");
  }

  function handlePicked(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (picked.length > 0) attachments.addFiles(picked, "picker");
  }

  function fillFromStarter(value: string) {
    setText(value);
    // 값이 그려진 뒤에 커서를 끝으로 옮긴다. 지금 옮기면 이전 값의 끝에 선다.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(value.length, value.length);
    });
  }

  const share = limits.maxMessageTokens > 0 ? totalTokens / limits.maxMessageTokens : 0;
  const totalTone = overBudget ? "danger" : share > WARN_SHARE ? "warning" : "normal";
  // The gate outranks a transient notice: it is the reason send is off.
  const message = overBudget
    ? { tone: "warning" as const, text: draftOverBudget(totalTokens, limits.maxMessageTokens) }
    : attachments.notice;

  const isEmbedding = kind === "embedding";
  const browserActive = useBrowserControlActive();
  // 데스크톱에서는 첨부와 크롬 제어가 "+" 메뉴 안으로 들어간다. 폰은 메뉴를 한 번 더 여는
  // 것이 손가락에 멀어 클립을 그대로 두고, 임베딩 대화는 "+" 자체가 없어 클립이 남는다.
  const attachInMenu = !isEmbedding && !touch;

  return (
    <>
      <div className="composer">
        {/* Said before anything is typed: on an embedding model Enter does not
            produce an answer, it produces a vector. */}
        {isEmbedding && (
          <p className="composer-mode-notice" role="status">
            {EMBEDDING_MODE_NOTICE}
          </p>
        )}

        {hasAttachments && (
          <>
            <div className="composer-attachments">
              {items.map((item) => (
                <AttachmentChip
                  key={item.localId}
                  item={item}
                  overBudget={attachments.overBudgetIds.has(item.localId)}
                  onPreview={() => setPreview(previewTargetFor(item))}
                  onRemove={() => attachments.remove(item.localId)}
                  onRetry={() => attachments.retry(item.localId)}
                />
              ))}
            </div>
            <p className="composer-attachment-total" data-tone={totalTone}>
              {attachmentTotal(items.length, totalTokens, limits.maxMessageTokens)}
            </p>
          </>
        )}

        {message && (
          <p className="composer-attachment-error" role="status" data-tone={message.tone}>
            {message.text}
          </p>
        )}

        <div className="composer-input-row">
          {/* An embedding turn calls no tools, so the picker would only offer a
              setting that changes nothing — same reason the reasoning control is
              hidden there. */}
          {!isEmbedding && (
            <div className="composer-leading">
              <McpPicker
                conversation={conversation}
                onOpenLibrary={onOpenLibrary}
                onOpenTools={onOpenTools}
                onAttach={attachInMenu ? () => fileInputRef.current?.click() : undefined}
                extraRows={attachInMenu ? <BrowserControlToggle variant="row" /> : undefined}
              />
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="composer-textarea"
            placeholder={compacting ? COMPACTING_PLACEHOLDER : composerPlaceholder(kind, conversation.messages.length > 0)}
            disabled={compacting}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            readOnly={pendingSubmit}
            rows={1}
          />
          <div className="composer-trailing">
            {/* 크롬 제어는 "+" 메뉴에서 켜고, 켜져 있는 동안만 여기 아이콘이 남는다 — 모델이
                사용자의 브라우저를 만질 수 있는 상태는 메뉴를 열지 않아도 보여야 한다. */}
            {attachInMenu && browserActive && <BrowserControlToggle />}
            {!attachInMenu && (
              <button
                type="button"
                className="btn-icon composer-attach"
                onClick={() => fileInputRef.current?.click()}
                data-tooltip="파일 첨부"
                aria-label="파일 첨부"
              >
                <PaperclipIcon />
              </button>
            )}
            {/* No `accept` filter: the one validator decides, and a filtered
                picker would hide the very files whose refusal carries the
                workaround (a PDF can never be picked to be told to screenshot
                it). Drag-and-drop and paste cannot be filtered either, so this
                keeps all three paths behaving identically. */}
            <input ref={fileInputRef} type="file" multiple hidden onChange={handlePicked} />
            {/* An embedding model does not reason — the control would only
                offer a setting that changes nothing. */}
            {!isEmbedding && (
              <ReasoningControl
                level={conversation.settings.reasoningLevel}
                mode={conversation.settings.reasoningMode}
                reasoningFixed={reasoningFixed}
                thinkingTokenBudget={budget}
                onLevelChange={handleLevelChange}
                onModeChange={handleModeChange}
                onBudgetChange={setBudget}
              />
            )}
            {compacting ? (
              // 압축 중에는 멈추기도 보내기도 받지 않는다 — 압축은 끝까지 가서 저장된다.
              <button
                type="button"
                className="btn btn-primary composer-send composer-send-waiting"
                disabled
                aria-label={COMPACTING_PLACEHOLDER}
                data-tooltip={COMPACTING_PLACEHOLDER}
              >
                <span className="composer-send-spinner" aria-hidden="true" />
              </button>
            ) : isStreaming ? (
              <button
                type="button"
                className="btn btn-danger composer-send"
                onClick={onStop}
                aria-label="생성 중지"
                data-tooltip="생성 중지"
              >
                <StopIcon />
              </button>
            ) : pendingSubmit ? (
              // aria-disabled rather than disabled: it reads and looks disabled,
              // but a second click still has to be able to cancel the queue.
              <button
                type="button"
                className="btn btn-primary composer-send composer-send-waiting"
                onClick={() => setPendingSubmit(false)}
                aria-disabled="true"
                aria-label={WAITING_FOR_UPLOAD}
                data-tooltip={`${WAITING_FOR_UPLOAD} (Esc 취소)`}
              >
                <span className="composer-send-spinner" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary composer-send"
                onClick={submit}
                disabled={!canSend}
                aria-label={isEmbedding ? "임베딩 실행" : "메시지 전송"}
                data-tooltip={composerKeyHint(kind, touch)}
              >
                <SendIcon />
              </button>
            )}
          </div>
        </div>

        {preview && <AttachmentPreview target={preview} onClose={() => setPreview(null)} />}
      </div>
      {/* 임베딩 대화는 답을 하지 않으니 "찾아 줘·정리해 줘" 칩이 맞지 않는다. */}
      {showStarters && !isEmbedding && (
        <div className="composer-starters" role="group" aria-label="이렇게 시작해 보세요">
          {STARTERS.map((starter) => (
            <button
              key={starter.label}
              type="button"
              className="composer-starter"
              data-wide-only={starter.wideOnly ? "" : undefined}
              disabled={compacting}
              onClick={() => ("pickFile" in starter ? fileInputRef.current?.click() : fillFromStarter(starter.text))}
            >
              {starter.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
