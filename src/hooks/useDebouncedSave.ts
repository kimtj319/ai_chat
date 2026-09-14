import { useEffect, useRef, useState } from "react";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

/**
 * Debounce-saves `value` via `save` whenever it changes (skipping the
 * initial mount, so opening a panel pre-filled from the server never fires
 * a spurious save). Returns a small state machine a UI can render as a
 * subtle "saving…" / "saved" / error indicator.
 */
export function useDebouncedSave<T>(value: T, save: (value: T) => Promise<unknown>, delayMs = 600): SaveStatus {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const isFirstRun = useRef(true);
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    const timeout = setTimeout(() => {
      setStatus("saving");
      saveRef.current(value)
        .then(() => setStatus("saved"))
        .catch(() => setStatus("error"));
    }, delayMs);
    return () => clearTimeout(timeout);
  }, [value, delayMs]);

  return status;
}
