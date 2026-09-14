import { useState } from "react";
import { copyText } from "../state/clipboard";
import { showToast } from "./Toast";

interface CopyButtonProps {
  text: string;
  label?: string;
  className?: string;
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function CopyButton({ text, label = "복사", className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    // Not navigator.clipboard directly: it does not exist on a plain-HTTP
    // origin, which is where this app runs, and reading .writeText off the
    // missing object used to throw into a catch that said nothing — so the
    // button did nothing and looked like it had worked.
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      showToast("복사되었습니다.");
      return;
    }
    showToast("복사하지 못했습니다.");
  }

  return (
    <button
      type="button"
      className={className ?? "btn-icon"}
      onClick={handleCopy}
      aria-label={copied ? "복사됨" : label}
      data-tooltip={copied ? "복사됨" : label}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}
