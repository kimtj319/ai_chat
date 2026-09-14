import { useCallback, useRef, useState, type DragEvent } from "react";

function carriesFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  // `types` is a DOMStringList-ish in some browsers, so no Array.prototype here.
  return Array.prototype.includes.call(types, "Files") as boolean;
}

/**
 * Drop-target state for a whole region.
 *
 * dragenter/dragleave fire once per element the pointer crosses, so a naive
 * boolean strobes the overlay on and off as the cursor moves over the
 * transcript's children. A depth counter is the fix: only the leave that
 * balances the first enter puts the overlay away.
 */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [isDragging, setIsDragging] = useState(false);
  const depth = useRef(0);

  const onDragEnter = useCallback((event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth.current += 1;
    setIsDragging(true);
  }, []);

  const onDragOver = useCallback((event: DragEvent) => {
    if (!carriesFiles(event)) return;
    // Without this the browser navigates to the dropped file instead.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((event: DragEvent) => {
    if (!carriesFiles(event)) return;
    depth.current -= 1;
    if (depth.current <= 0) {
      depth.current = 0;
      setIsDragging(false);
    }
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setIsDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );

  return { isDragging, dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
