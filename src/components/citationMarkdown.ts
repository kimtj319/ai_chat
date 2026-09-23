/**
 * 답변 본문의 "[1]", "[1][3]", "[1, 2]" 를 출처 링크로 바꾸는 remark 플러그인.
 *
 * 글자(text) 노드만 본다. 코드 블록·인라인 코드는 text 노드가 아니므로 `a[1]` 같은
 * 코드는 건드리지 않는다. 번호가 이 답변의 출처 목록에 없으면 그대로 글자로 둔다 —
 * 모델이 없는 번호를 쓰면 링크가 어디로도 가지 않는 것보다 글자인 편이 정직하다.
 *
 * 링크 주소는 `#cite-<n>` 이고, MarkdownRenderer 의 `a` 가 그것을 알아보고 버튼으로
 * 그린다.
 */

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

const CITE = /\[(\d{1,3}(?:\s*[,，]\s*\d{1,3})*)\]/g;

export function remarkCitations(valid: ReadonlySet<number>) {
  return () => (tree: MdNode) => {
    walk(tree, valid);
  };
}

function walk(node: MdNode, valid: ReadonlySet<number>): void {
  if (!node.children) return;
  // 링크 안의 글자는 이미 링크다. 그 안에 링크를 또 넣지 않는다.
  if (node.type === "link" || node.type === "linkReference") return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value) {
      next.push(...split(child.value, valid));
    } else {
      walk(child, valid);
      next.push(child);
    }
  }
  node.children = next;
}

function split(value: string, valid: ReadonlySet<number>): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  for (const m of value.matchAll(CITE)) {
    const numbers = m[1]!.split(/[,，]/).map((s) => Number(s.trim()));
    if (!numbers.every((n) => valid.has(n))) continue;
    if (m.index! > last) out.push({ type: "text", value: value.slice(last, m.index) });
    for (const n of numbers) {
      out.push({ type: "link", url: `#cite-${n}`, children: [{ type: "text", value: String(n) }] });
    }
    last = m.index! + m[0].length;
  }
  if (last === 0) return [{ type: "text", value }];
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}
