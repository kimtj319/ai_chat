/**
 * 답변 속 `<br>` 을 줄바꿈으로.
 *
 * 마크다운 표는 한 칸 안에서 줄을 바꿀 길이 없어서 모델이 `<br>` 을 쓴다. 이 렌더러는
 * 원시 HTML 을 그리지 않으므로(답변에 스크립트가 섞여도 안전하게) 그 태그가 글자
 * 그대로 "1<br>2" 로 보였다. `<br>` 하나만 골라 마크다운의 줄바꿈 노드로 바꾼다 —
 * 다른 HTML 은 여전히 그리지 않고, 코드 안의 `<br>` 은 코드 그대로 둔다.
 */
const BR = /^<br\s*\/?>$/i;

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

function walk(node: MdNode): void {
  if (!node.children) return;
  node.children = node.children.map((child) => (child.type === "html" && BR.test(child.value?.trim() ?? "") ? { type: "break" } : child));
  node.children.forEach(walk);
}

export function remarkBreakTags() {
  return (tree: MdNode) => walk(tree);
}
