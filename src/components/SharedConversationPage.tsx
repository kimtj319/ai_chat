import { useEffect, useState } from "react";
import { getSharedConversation, sharedAttachmentUrl, type SharedConversation } from "../api/client";
import { CHAT_HASH } from "../routes";
import { AppBackdrop } from "./AppBackdrop";
import { BrandMark } from "./BrandMark";
import { MessageItem } from "./MessageItem";
import { SourcePanel } from "./SourcePanel";
import "./ChatView.css";
import "./SharedConversationPage.css";

/**
 * 공유 링크(#/share/<토큰>)로 연 대화. **읽기 전용**이다.
 *
 * 대화 화면과 같은 칸(chat-view·chat-message-list)과 같은 MessageItem 을 써서 보낸
 * 사람이 본 모습 그대로 보인다. 다른 것은 셋뿐이다:
 *   - 입력창이 없다. 서버에도 이 사본에 이어 말할 경로가 없다(routes/share.ts).
 *   - 사이드바·스토어가 없다. 로그인하지 않은 사람도 여는 화면이라 계정에 딸린 것을
 *     하나도 부르지 않는다.
 *   - 첨부는 사본에서 받는다. 원본 첨부는 소유자만 받을 수 있다.
 */
export function SharedConversationPage({ token }: { token: string }) {
  const [share, setShare] = useState<SharedConversation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setShare(null);
    setError(null);
    getSharedConversation(token)
      .then((result) => {
        if (!cancelled) setShare(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (share) document.title = `${share.title} · 공유된 대화`;
  }, [share]);

  const sharedOn = share ? new Date(share.sharedAt).toLocaleDateString("ko-KR") : "";
  const attachmentUrlFor = (attachmentId: string) => sharedAttachmentUrl(token, attachmentId);

  return (
    <div className="app-shell shared-shell">
      <AppBackdrop />
      <div className={`chat-view${share ? " has-messages" : ""}`}>
        <header className="chat-header">
          <div className="chat-header-inner">
            <div className="chat-header-left shared-header-left">
              <BrandMark size={24} className="shared-brand" />
              <div className="shared-meta">
                <h1 className="shared-title">{share?.title ?? "공유된 대화"}</h1>
                {/* 좁은 폭에서 뒤가 잘리므로 가장 중요한 "읽기 전용" 을 앞에 둔다. */}
                {share && <span className="shared-subtitle">읽기 전용 · {sharedOn} 공유</span>}
              </div>
            </div>
            <div className="chat-header-right">
              {/* 앱 첫 화면으로. 계정이 없으면 거기서 로그인 화면을 만난다. */}
              <a className="btn btn-secondary shared-open-app" href={CHAT_HASH}>
                AI Console 열기
              </a>
            </div>
          </div>
        </header>

        <div className="chat-message-list">
          <div className="chat-message-list-inner">
            {error ? (
              <div className="chat-empty-state">
                <p className="message-error">{error}</p>
                <p className="shared-note">링크가 잘못되었거나 공유가 지워졌을 수 있습니다.</p>
              </div>
            ) : !share ? (
              <div className="chat-empty-state">
                <p>대화를 불러오는 중…</p>
              </div>
            ) : (
              <>
                {share.messages.map((message) => (
                  <MessageItem key={message.id} conversationId="" message={message} attachmentUrlFor={attachmentUrlFor} />
                ))}
                <p className="shared-footer-note" role="note">
                  공유된 대화는 읽기 전용입니다. 이 대화에 이어서 질문할 수 없습니다.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
      {/* 답변 속 출처 [n]. 문서 원본은 소유자만 받을 수 있어, 받는 사람에게는 인용된 단락만 보인다. */}
      <SourcePanel />
    </div>
  );
}
