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
  // The change the timer has not saved yet. Leaving the panel (뒤로, or a
  // conversation switch that unmounts the composer) must not drop it.
  const pendingRef = useRef<{ value: T } | null>(null);

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    pendingRef.current = { value };
    const timeout = setTimeout(() => {
      pendingRef.current = null;
      setStatus("saving");
      saveRef.current(value)
        .then(() => setStatus("saved"))
        .catch(() => setStatus("error"));
    }, delayMs);
    return () => clearTimeout(timeout);
  }, [value, delayMs]);

  // Unmount only: save what is still pending right away. `save` is the closure
  // from the last render, so it still targets the conversation it was edited in
  // (the store guards the late response by conversation id). Nothing is left on
  // screen to show a failure, so it is swallowed.
  useEffect(
    () => () => {
      const pending = pendingRef.current;
      if (!pending) return;
      pendingRef.current = null;
      saveRef.current(pending.value).catch(() => undefined);
    },
    [],
  );

  return status;
}
