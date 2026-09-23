import { Component, isValidElement, useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import type { CitationSource } from "../state/citations";
import { openSource } from "../state/sourcePanel";
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

function CodeRenderer({ className, children }: { className?: string; children?: ReactNode }) {
  if (!className) {
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
  const language = match?.[1] ?? "text";
  const rawText = extractText(codeProps.children);

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{language}</span>
        <CopyButton text={rawText} className="code-block-copy" />
      </div>
      <pre>{codeElement}</pre>
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

export function MarkdownRenderer({ content, citations }: MarkdownRendererProps) {
  const byNumber = useMemo(() => new Map((citations ?? []).map((c) => [c.n, c])), [citations]);
  const remarkPlugins = useMemo(
    () => (byNumber.size > 0 ? [remarkGfm, remarkMath, remarkCitations(new Set(byNumber.keys()))] : [remarkGfm, remarkMath]),
    [byNumber],
  );
  const components = useMemo(
    () => ({
      pre: PreRenderer,
      code: CodeRenderer,
      a: ({ href, children }: { href?: string; children?: ReactNode }) => {
        const cite = href?.startsWith("#cite-") ? byNumber.get(Number(href.slice(6))) : undefined;
        if (cite) return <CitationLink source={cite} />;
        return <a href={href}>{children}</a>;
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
