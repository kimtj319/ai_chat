import type { ConversationKind } from "../api/types";
import { conversationKindMeta } from "../state/modelCapability";

interface CapabilityIconProps {
  kind: ConversationKind | undefined | null;
  className?: string;
}

/**
 * The quiet marker on a conversation row: a speech bubble for a chat
 * conversation, a small vector grid for an embedding one. currentColor only,
 * so it inherits the row's (and the theme's) text colour, and it carries the
 * kind as a label rather than being icon-only for a screen reader.
 */
export function CapabilityIcon({ kind, className }: CapabilityIconProps) {
  const meta = conversationKindMeta(kind);

  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={meta.label}
    >
      <title>{meta.label}</title>
      {meta.icon === "embedding" ? (
        <>
          {/* Three rows of cells: a vector, not a sentence. */}
          <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
          <path d="M3.5 9.7h17M3.5 14.3h17M9.2 5v14" />
        </>
      ) : (
        <path d="M7.5 4.5h9a3.5 3.5 0 0 1 3.5 3.5v4.5a3.5 3.5 0 0 1-3.5 3.5h-5.2L7 19.5V16a3.5 3.5 0 0 1-3-3.5V8a3.5 3.5 0 0 1 3.5-3.5Z" />
      )}
    </svg>
  );
}
