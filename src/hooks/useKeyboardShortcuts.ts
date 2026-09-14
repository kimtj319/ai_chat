import { useEffect } from "react";
import { overlayOpen } from "../ui/overlayStack";

interface ShortcutHandlers {
  onNewConversation: () => void;
  onStop: () => void;
}

/**
 * Cmd/Ctrl+K -> new conversation, Esc -> stop generation. Enter/Shift+Enter are
 * handled locally by the composer.
 *
 * Esc 는 떠 있는 것(모달·드롭다운)이 없을 때만 생성을 멈춘다 — overlayStack 참고.
 */
export function useKeyboardShortcuts({ onNewConversation, onStop }: ShortcutHandlers): void {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onNewConversation();
        return;
      }
      if (event.key === "Escape") {
        // 떠 있는 것이 있으면 Esc 는 그것의 몫이다. 이 줄이 없으면 답변을
        // 기다리다 모달을 Esc 로 닫을 때 답변까지 끊긴다 — window 리스너끼리는
        // 서로를 막을 수 없어서, 둘 다 그대로 실행되기 때문이다.
        if (overlayOpen()) return;
        onStop();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onNewConversation, onStop]);
}
