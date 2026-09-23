import "./AnswerNowButton.css";

interface AnswerNowButtonProps {
  /** shouldShowAnswerNowButton(...) 이거나, 이미 눌러서 "정리하는 중" 인 동안. */
  show: boolean;
  /** 이미 눌렀다 — 다시 누를 수 없고 문구가 바뀐다. */
  pending: boolean;
  onClick: () => void;
}

/**
 * 입력창 위에 뜨는 "지금 답변하기" 배너.
 *
 * 바깥 div 는 `show` 와 무관하게 항상 DOM 에 있다 — aria-live 영역은 내용이
 * *바뀔 때* 알리므로, 영역 자체가 나타나고 사라지면(마운트/언마운트) 스크린
 * 리더가 놓칠 수 있다. 안쪽 배너만 조건부로 넣어서, 뜰 때는 내용이 새로
 * 생기는 변화로 알려지고, 사라질 때는 조용히 비워진다.
 */
export function AnswerNowButton({ show, pending, onClick }: AnswerNowButtonProps) {
  return (
    <div className="answer-now-region" aria-live="polite">
      {show && (
        <div className="answer-now-banner">
          <span className="answer-now-text">생각이 길어지고 있습니다.</span>
          <button type="button" className="btn btn-primary answer-now-button" onClick={onClick} disabled={pending}>
            {pending ? "답변을 정리하는 중…" : "지금 답변하기"}
          </button>
        </div>
      )}
    </div>
  );
}
