import { Modal } from "./Modal";
import "./ConfirmDialog.css";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** 제목에 사용자가 지은 이름이 들어가 길어지는 창은 넓게 연다. */
  width?: number;
}

export function ConfirmDialog({ title, message, confirmLabel = "확인", danger, onConfirm, onCancel, width = 380 }: ConfirmDialogProps) {
  return (
    <Modal title={title} onClose={onCancel} width={width}>
      <p className="confirm-message">{message}</p>
      <div className="confirm-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          취소
        </button>
        <button type="button" className={danger ? "btn btn-danger" : "btn btn-primary"} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
