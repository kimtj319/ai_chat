import { usePendingBrowserConfirm } from "../browser/confirm";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * 모델이 사용자의 크롬에서 하려는 일을 사용자에게 묻는 창. 처음 가는 사이트의 허용과,
 * 제출·전송·구매·삭제처럼 보이는 동작의 실행을 여기서 받는다(browser/confirm.ts).
 * 한 번에 하나씩 띄운다.
 */
export function BrowserConfirmHost() {
  const pending = usePendingBrowserConfirm();
  if (!pending) return null;
  const site = pending.request.kind === "site";
  return (
    <ConfirmDialog
      key={pending.id}
      title={site ? "사이트 허용 — 크롬 제어" : "이 동작을 실행할까요? — 크롬 제어"}
      message={
        site
          ? `${pending.request.message}\n허용한 사이트는 확장 프로그램 창에서 언제든 지울 수 있습니다.`
          : `${pending.request.message}\n되돌리기 어려운 동작일 수 있습니다.`
      }
      confirmLabel={site ? "허용" : "실행"}
      danger={!site}
      onConfirm={() => pending.resolve(true)}
      onCancel={() => pending.resolve(false)}
    />
  );
}
