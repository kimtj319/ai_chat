import { Component, cloneElement, isValidElement, useEffect, useLayoutEffect, useMemo, useRef, type ComponentPropsWithoutRef, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import { gfm } from "./markdownGfm";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import type { CitationSource } from "../state/citations";
import { openSource } from "../state/sourcePanel";
import { stableStreamingMarkdown } from "../state/streamingMarkdown";
import { remarkCitations } from "./citationMarkdown";
import { CopyButton } from "./CopyButton";
import "./MarkdownRenderer.css";

function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return extractText(props.children);
  }
  return "";
}

function CodeRenderer({ className, children, "data-block": block }: { className?: string; children?: ReactNode; "data-block"?: boolean }) {
  // <pre> 안의 코드는 언어가 없어도 인라인 칩이 아니다(PreRenderer 가 data-block 으로 표시).
  if (!className && !block) {
    return <code className="inline-code">{children}</code>;
  }
  return <code className={className}>{children}</code>;
}

function PreRenderer({ children }: { children?: ReactNode }) {
  const codeElement = Array.isArray(children) ? children[0] : children;

  if (!isValidElement(codeElement)) {
    return <pre>{children}</pre>;
  }

  const codeProps = codeElement.props as { className?: string; children?: ReactNode };
  const match = /language-(\w+)/.exec(codeProps.className ?? "");
  const language = match?.[1] ?? "텍스트";
  const rawText = extractText(codeProps.children);

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{language}</span>
        <CopyButton text={rawText} className="code-block-copy" />
      </div>
      <pre>{cloneElement(codeElement as ReactElement<{ "data-block"?: boolean }>, { "data-block": true })}</pre>
    </div>
  );
}

interface BoundaryProps {
  resetKey: string;
  fallback: ReactNode;
  children: ReactNode;
}

interface BoundaryState {
  hasError: boolean;
}

/**
 * Streaming markdown can be momentarily invalid (an unterminated code fence
 * or an unbalanced $...$ math span). Rather than let that crash the message
 * list, fall back to plain text and retry as soon as more content arrives.
 */
class MarkdownBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { hasError: false };

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }

  override componentDidUpdate(prevProps: BoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  override render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

interface MarkdownRendererProps {
  content: string;
  /** 이 답변의 문서 출처. 있으면 본문의 "[n]" 이 그 단락을 여는 링크가 된다. */
  citations?: readonly CitationSource[];
  /** 아직 흘러 들어오는 중 — 반쯤 온 표 줄을 감춘다(state/streamingMarkdown.ts). */
  streaming?: boolean;
}

/**
 * 열 너비가 줄어들지 않는 표. 표는 행이 하나씩 붙으며 그려지는데, 자동 배치는
 * 행마다 열 너비를 다시 정해 표가 좌우로 들쭉날쭉했다. 첫 행의 각 칸이 지금까지
 * 가졌던 가장 넓은 너비를 최소 너비로 붙잡아 두면, 열은 넓어질 수만 있어 곧
 * 자리를 잡고 그대로 간다.
 */
function StableTable(props: ComponentPropsWithoutRef<"table">) {
  const ref = useRef<HTMLTableElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 가로로 넘칠 때만 오른쪽 끝에 흐림 표시(data-overflow)를 건다.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const update = () => {
      const more = box.scrollWidth - box.clientWidth - box.scrollLeft > 1;
      if (more) box.setAttribute("data-overflow", "end");
      else box.removeAttribute("data-overflow");
    };
    update();
    box.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(box);
    if (ref.current) observer?.observe(ref.current);
    return () => {
      box.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, []);
  const widths = useRef<number[]>([]);
  useLayoutEffect(() => {
    const row = ref.current?.querySelector("tr");
    if (!row) return;
    Array.from(row.children).forEach((cell, i) => {
      const width = Math.ceil((cell as HTMLElement).getBoundingClientRect().width);
      if (width > (widths.current[i] ?? 0)) widths.current[i] = width;
      (cell as HTMLElement).style.minWidth = `${widths.current[i]}px`;
    });
  });
  return (
    <div className="md-table-scroll" ref={scrollRef}>
      <table ref={ref} {...props} />
    </div>
  );
}

/** 출처 번호. 누르면 오른쪽 창에 그 단락의 원문이 열린다. */
function CitationLink({ source }: { source: CitationSource }) {
  return (
    <button
      type="button"
      className="citation-link"
      data-tooltip={source.title || "출처"}
      aria-label={`출처 ${source.n}: ${source.title}`}
      onClick={() => openSource(source)}
    >
      {source.n}
    </button>
  );
}

export function MarkdownRenderer({ content: raw, citations, streaming = false }: MarkdownRendererProps) {
  const content = streaming ? stableStreamingMarkdown(raw) : raw;
  const byNumber = useMemo(() => new Map((citations ?? []).map((c) => [c.n, c])), [citations]);
  const remarkPlugins = useMemo(
    () => (byNumber.size > 0 ? [gfm, remarkMath, remarkCitations(new Set(byNumber.keys()))] : [gfm, remarkMath]),
    [byNumber],
  );
  const components = useMemo(
    () => ({
      pre: PreRenderer,
      code: CodeRenderer,
      table: ({ node: _node, ...rest }: ComponentPropsWithoutRef<"table"> & { node?: unknown }) => <StableTable {...rest} />,
      a: ({ href, children }: { href?: string; children?: ReactNode }) => {
        const cite = href?.startsWith("#cite-") ? byNumber.get(Number(href.slice(6))) : undefined;
        if (cite) return <CitationLink source={cite} />;
        // 답변 속 링크는 늘 새 탭으로 — 누르면 대화가 사라지던 것. 같은 답변 안의 각주(#…)만 제자리.
        if (href?.startsWith("#")) return <a href={href}>{children}</a>;
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
    }),
    [byNumber],
  );
  return (
    <div className="markdown-body">
      <MarkdownBoundary resetKey={content} fallback={<pre className="markdown-raw-fallback">{content}</pre>}>
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={[rehypeHighlight, rehypeKatex]} components={components}>
          {content}
        </ReactMarkdown>
      </MarkdownBoundary>
    </div>
  );
}
