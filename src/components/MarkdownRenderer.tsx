import {
  Component,
  Fragment,
  cloneElement,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkMath from "remark-math";
import { gfm } from "./markdownGfm";
import { remarkBreakTags } from "./markdownBreaks";
import rehypeHighlight from "rehype-highlight";
import type rehypeKatex from "rehype-katex";
import type { CitationSource } from "../state/citations";
import { openSource } from "../state/sourcePanel";
import { splitMarkdownBlocks, stableStreamingMarkdown } from "../state/streamingMarkdown";
import { remarkCitations } from "./citationMarkdown";
import { CopyButton } from "./CopyButton";
import "./MarkdownRenderer.css";

/**
 * 색칠기는 한 번만 세운다. 플러그인으로 rehypeHighlight 를 그대로 넘기면 렌더마다 새
 * highlight.js 인스턴스를 만들어 문법을 다시 등록하고 다시 컴파일한다 — 흘러 들어오는
 * 답에서는 조각마다다. 변환 함수는 상태가 없어 같이 써도 된다.
 */
const highlightTransformer = rehypeHighlight();
function rehypeHighlightShared() {
  return highlightTransformer;
}

/**
 * 수식(KaTeX)은 첫 화면 묶음에서 빼고, 수식이 든 답이 처음 그려질 때 불러온다
 * (markdownMath.ts). 한 번 불러오면 탭이 열려 있는 동안 모든 답이 함께 쓴다. 불러오는
 * 동안 수식은 TeX 원문 그대로 보인다.
 */
let loadedKatex: typeof rehypeKatex | null = null;
let katexLoading: Promise<void> | null = null;
function loadKatex(): Promise<void> {
  katexLoading ??= import("./markdownMath").then(
    (module) => {
      loadedKatex = module.default;
    },
    () => {
      // 네트워크가 끊겼던 것이면 다음에 수식을 만났을 때 다시 시도한다.
      katexLoading = null;
    },
  );
  return katexLoading;
}

/** 화면 밖에서 그려 바로 찍는 곳(문서 PDF)은 수식이 그려진 뒤에 찍도록 먼저 부른다. */
export function preloadMarkdownMath(): Promise<void> {
  return loadKatex();
}

function useKatex(needed: boolean): typeof rehypeKatex | null {
  const [katex, setKatex] = useState(() => loadedKatex);
  useEffect(() => {
    if (!needed || katex) return;
    let live = true;
    void loadKatex().then(() => {
      if (live && loadedKatex) setKatex(() => loadedKatex);
    });
    return () => {
      live = false;
    };
  }, [needed, katex]);
  return katex;
}

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
  // KaTeX 를 불러오는 동안의 블록 수식. 'math' 코드 블록의 머리와 복사 단추가 잠깐
  // 떴다 사라지지 않게 원문만 둔다.
  if (codeProps.className?.includes("math-display")) return <pre>{children}</pre>;
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

interface MarkdownBlockProps {
  text: string;
  remarkPlugins: Options["remarkPlugins"];
  rehypePlugins: Options["rehypePlugins"];
  components: Components;
}

/**
 * 블록 묶음 하나. memo 라 글이 같고 플러그인이 그대로면 다시 해석하지 않는다 —
 * 흘러 들어오는 동안 다시 그려지는 것은 자라는 마지막 묶음뿐이다.
 */
const MarkdownBlock = memo(function MarkdownBlock({ text, remarkPlugins, rehypePlugins, components }: MarkdownBlockProps) {
  return (
    <MarkdownBoundary resetKey={text} fallback={<pre className="markdown-raw-fallback">{text}</pre>}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </MarkdownBoundary>
  );
});

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
  const katex = useKatex(content.includes("$"));
  // 끝난 블록 묶음 + 자라는 꼬리. 이어 그린 결과는 통째로 그린 것과 같다
  // (splitMarkdownBlocks 설명, markdownBlocks.test.ts). 다 온 답도 같은 길로 그려,
  // 답이 끝나는 순간 이미 그려 둔 묶음을 버리고 처음부터 다시 그리지 않는다.
  const blocks = useMemo(() => splitMarkdownBlocks(content), [content]);
  const rehypePlugins = useMemo(() => (katex ? [rehypeHighlightShared, katex] : [rehypeHighlightShared]), [katex]);
  const byNumber = useMemo(() => new Map((citations ?? []).map((c) => [c.n, c])), [citations]);
  const remarkPlugins = useMemo(
    () => (byNumber.size > 0
        ? [gfm, remarkMath, remarkBreakTags, remarkCitations(new Set(byNumber.keys()))]
        : [gfm, remarkMath, remarkBreakTags]),
    [byNumber],
  );
  const components = useMemo<Components>(
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
      {blocks.map((block, index) => (
        // 묶음은 앞에서부터 쌓이기만 하므로 순번이 곧 정체다. 사이의 "\n" 은 통째로
        // 그릴 때 블록 사이에 생기는 글자 노드와 같게 하려는 것.
        <Fragment key={index}>
          {index > 0 && "\n"}
          <MarkdownBlock text={block} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} />
        </Fragment>
      ))}
    </div>
  );
}
