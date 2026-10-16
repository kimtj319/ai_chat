import { usePendingBrowserConfirm } from "../browser/confirm";
import { Modal } from "./Modal";
import "./ConfirmDialog.css";
import "./BrowserConfirmHost.css";

/**
 * 모델이 사용자의 크롬에서 하려는 일을 사용자에게 묻는 창. 처음 가는 사이트의 허용과,
 * 제출·전송·구매·삭제처럼 보이는 동작의 실행을 여기서 받는다(browser/confirm.ts).
 * 동작 확인에는 누르려는 대상에 강조 상자를 그린 화면을 함께 보여 준다.
 * 한 번에 하나씩 띄운다. 닫거나 Esc 는 거절이다.
 */
export function BrowserConfirmHost() {
  const pending = usePendingBrowserConfirm();
  if (!pending) return null;
  const { request } = pending;
  const site = request.kind === "site";
  return (
    <Modal
      key={pending.id}
      title={site ? "사이트 허용 — 크롬 제어" : "이 동작을 실행할까요? — 크롬 제어"}
      onClose={() => pending.resolve(false)}
      width={request.preview ? 560 : 400}
    >
      <p className="confirm-message">
        {request.message}
        {"\n"}
        {site ? "허용한 사이트는 확장 프로그램 창에서 언제든 지울 수 있습니다." : "되돌리기 어려운 동작일 수 있습니다."}
      </p>
      {request.preview && (
        <figure className="browser-confirm-preview">
          <img src={request.preview.image} alt={`누르려는 대상이 강조된 화면 — ${request.preview.caption}`} />
          <figcaption>주황색 상자가 모델이 누르거나 입력하려는 곳입니다.</figcaption>
        </figure>
      )}
      <div className="confirm-actions">
        <button type="button" className="btn btn-secondary" onClick={() => pending.resolve(false)}>
          취소
        </button>
        <button type="button" className={site ? "btn btn-primary" : "btn btn-danger"} onClick={() => pending.resolve(true)}>
          {site ? "허용" : "실행"}
        </button>
      </div>
    </Modal>
  );
}
