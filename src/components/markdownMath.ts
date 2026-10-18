// 수식 렌더러와 그 CSS. 답에 "$" 가 있을 때에만 MarkdownRenderer 가 import() 로 불러온다 —
// 둘을 합치면 첫 화면 묶음의 4분의 1이 넘는데, 수식이 든 답은 드물다.
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

export default rehypeKatex;
