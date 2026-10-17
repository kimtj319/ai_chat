import type { ReactNode, SVGProps } from "react";

/* Line icons shared across components (the sidebar's and its settings
   screen's included). All share the same 24px, 1.5-stroke frame; a caller can
   add attributes such as aria-hidden. */

function LineIcon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      {children}
    </svg>
  );
}

export function ChevronRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <path d="M9 6l6 6-6 6" />
    </LineIcon>
  );
}

export function ChevronDownIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <path d="M6 9l6 6 6-6" />
    </LineIcon>
  );
}

export function CloseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </LineIcon>
  );
}

export function RefreshIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <path d="M20 11a8 8 0 1 0-.6 4" />
      <path d="M20 4v7h-7" />
    </LineIcon>
  );
}

export function DownloadIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 19.5h16" />
    </LineIcon>
  );
}

export function PaperclipIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <path d="M21.4 11.1 12.3 20.2a5.5 5.5 0 0 1-7.8-7.8l9.2-9.2a3.7 3.7 0 0 1 5.2 5.2l-9.2 9.2a1.8 1.8 0 0 1-2.6-2.6l8.5-8.5" />
    </LineIcon>
  );
}

export function PanelIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M9 5v14" />
    </LineIcon>
  );
}

export function EditIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </LineIcon>
  );
}

export function TrashIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </LineIcon>
  );
}

export function SlidersIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <line x1="4" y1="6" x2="20" y2="6" />
      <circle cx="9" cy="6" r="1.75" fill="currentColor" stroke="none" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="15" cy="12" r="1.75" fill="currentColor" stroke="none" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="10" cy="18" r="1.75" fill="currentColor" stroke="none" />
    </LineIcon>
  );
}

export function WrenchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <path d="M21 7.3a4.5 4.5 0 0 1-6.02 4.24L7 19.5l-2.5-2.5 7.96-7.98A4.5 4.5 0 0 1 17.7 3l-3.2 3.2 1.5 1.5 3.2-3.2c.5.75.8 1.65.8 2.8Z" />
    </LineIcon>
  );
}

export function LibraryIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H8v16H5.5A1.5 1.5 0 0 1 4 18.5Z" />
      <path d="M11 4h2.5A1.5 1.5 0 0 1 15 5.5v13a1.5 1.5 0 0 1-1.5 1.5H11Z" />
      <path d="m17.4 6.6 1.9-.5a1 1 0 0 1 1.2.7l2.2 8.4" />
    </LineIcon>
  );
}

/** A sheet with lines on it. Deliberately not the library's books: one holds
 *  tools, this holds text, and at rail size the difference has to be the shape. */
export function DocumentIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </LineIcon>
  );
}

export function UploadIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <path d="M12 15V3" />
      <path d="M7 8l5-5 5 5" />
      <path d="M4 19.5h16" />
    </LineIcon>
  );
}

export function GearIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.32 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </LineIcon>
  );
}

export function ServerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </LineIcon>
  );
}

export function ShieldIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <path d="M12 3l7.5 3v5.5c0 4.4-3.1 8.4-7.5 9.5-4.4-1.1-7.5-5.1-7.5-9.5V6Z" />
      <path d="M9.5 12l1.8 1.8 3.4-3.6" />
    </LineIcon>
  );
}

export function BackIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <path d="M15 5l-7 7 7 7" />
    </LineIcon>
  );
}

export function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </LineIcon>
  );
}

export function KeyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9" />
      <path d="M17.5 12v3.5" />
      <path d="M20.5 12v2.5" />
    </LineIcon>
  );
}

export function LockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </LineIcon>
  );
}

export function LogoutIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LineIcon {...props}>
      <path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14" />
      <path d="M10 16l-4-4 4-4" />
      <path d="M6 12h9" />
    </LineIcon>
  );
}
