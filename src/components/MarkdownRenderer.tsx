import { Component, cloneElement, isValidElement, useEffect, useMemo, useRef, type ComponentPropsWithoutRef, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import { gfm } from "./markdownGfm";
import { remarkBreakTags } from "./markdownBreaks";
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
 * 가로로 넘치면 스크롤되는 표. 열 너비는 브라우저의 자동 배치에 맡긴다 — 예전에는
 * 흔들림을 막으려고 지나간 너비를 최소 너비로 붙잡았는데, 내용 없는 머리 줄의
 * 고른 너비까지 붙잡아 답이 끝날 때까지 첫 열이 넓게 남았다. 흔들림은 이제
 * stableStreamingMarkdown 이 첫 데이터 행 전의 표를 감춰서 막는다.
 */
function ScrollableTable(props: ComponentPropsWithoutRef<"table">) {
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
    () => (byNumber.size > 0
        ? [gfm, remarkMath, remarkBreakTags, remarkCitations(new Set(byNumber.keys()))]
        : [gfm, remarkMath, remarkBreakTags]),
    [byNumber],
  );
  const components = useMemo(
    () => ({
      pre: PreRenderer,
      code: CodeRenderer,
      table: ({ node: _node, ...rest }: ComponentPropsWithoutRef<"table"> & { node?: unknown }) => <ScrollableTable {...rest} />,
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
