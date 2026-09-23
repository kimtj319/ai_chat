import { layoutBlocks, type CutFinder } from "./pdfLayout";

/**
 * 대화 본문을 화면에 보이는 모습 그대로 PDF 로 만든다.
 *
 * 글자를 PDF 로 다시 조판하지 않고 브라우저가 그린 메시지를 그대로 찍어 붙인다.
 * 말풍선·코드 강조·수식·표·테마(라이트/다크)까지 화면과 같게 하려면 이것이
 * 유일하게 확실한 방법이다 — PDF 쪽에서 CSS 를 흉내 내면 반드시 어딘가 어긋난다.
 * 대신 PDF 안의 글자는 선택·검색되지 않는다.
 *
 * 쪽 너비는 화면의 본문 너비, 쪽 높이는 A4 비율이다. 쪽 바탕은 화면의 바탕색이다.
 *
 * 두 라이브러리(html-to-image, jspdf)는 PDF 를 누를 때만 받아 온다. 대부분의
 * 사용자는 누르지 않으므로 처음 여는 번들에 싣지 않는다.
 */

/** 찍는 해상도. 2 면 인쇄해도 글자 가장자리가 뭉개지지 않는다. */
const PIXEL_RATIO = 2;
/**
 * 브라우저가 만들 수 있는 캔버스의 한 변 한계(Safari 가 가장 좁다). 이보다 긴
 * 메시지는 해상도를 낮춰서 찍는다 — 찍지 못해서 빈칸이 되는 것보다 낫다.
 */
const MAX_CANVAS_SIDE = 16_000;
const A4_RATIO = 297 / 210;

/** 투명이 아닌 첫 바탕색을 조상 쪽으로 찾아 올라간다. 본문 목록 자체는 투명하다. */
function backgroundOf(el: Element): string {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && color !== "transparent" && !/rgba\(.*,\s*0\)$/.test(color)) return color;
  }
  return getComputedStyle(document.body).backgroundColor || "#ffffff";
}

/** getComputedStyle 는 "rgb(23, 24, 26)" 꼴로 준다. jsPDF 는 숫자 셋을 받는다. */
function rgbOf(color: string): [number, number, number] {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [255, 255, 255];
}

/** 쪽 끝에서 위로 이만큼(CSS px)까지 빈 줄을 찾는다. 글줄 몇 개 높이. */
const CUT_SEARCH_PX = 120;

/**
 * 가로 한 줄이 "빈 줄" 인가 — 글자가 지나가지 않는가. 글자는 가장자리를 부드럽게
 * 그리므로 글자가 걸친 줄에는 색이 여러 가지 섞인다. 바탕·코드 상자 바탕·테두리
 * 정도만 있는 줄(색 3가지 이하)을 빈 줄로 본다.
 */
function isBlankRow(data: Uint8ClampedArray, offset: number, width: number): boolean {
  const colors = new Set<number>();
  for (let x = 0; x < width; x++) {
    const i = offset + x * 4;
    // 아주 작은 차이(압축·합성 오차)는 같은 색으로 친다.
    colors.add(((data[i]! >> 3) << 10) | ((data[i + 1]! >> 3) << 5) | (data[i + 2]! >> 3));
    if (colors.size > 3) return false;
  }
  return true;
}

/** 찍은 메시지들에서 쪽을 자를 자리를 글줄 사이로 당긴다. */
function blankRowCutFinder(shots: { canvas: HTMLCanvasElement; ratio: number }[]): CutFinder {
  return (block, sourceY, maxSlice) => {
    const shot = shots[block];
    const ctx = shot?.canvas.getContext("2d", { willReadFrequently: true });
    if (!shot || !ctx) return maxSlice;
    const bottom = Math.floor((sourceY + maxSlice) * shot.ratio);
    const top = Math.max(Math.ceil(sourceY * shot.ratio), bottom - Math.round(CUT_SEARCH_PX * shot.ratio));
    if (bottom <= top) return maxSlice;
    const width = shot.canvas.width;
    const { data } = ctx.getImageData(0, top, width, bottom - top);
    for (let row = bottom - top - 1; row >= 0; row--) {
      if (isBlankRow(data, row * width * 4, width)) return (top + row) / shot.ratio - sourceY;
    }
    return maxSlice;
  };
}

function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export async function exportConversationPdf(listInner: HTMLElement, filename: string): Promise<void> {
  const blocks = [...listInner.children].filter((el): el is HTMLElement => el instanceof HTMLElement);
  if (blocks.length === 0) throw new Error("PDF 로 만들 메시지가 없습니다.");

  const [{ toCanvas }, { jsPDF }] = await Promise.all([import("html-to-image"), import("jspdf")]);

  const style = getComputedStyle(listInner);
  const background = backgroundOf(listInner);
  const innerRect = listInner.getBoundingClientRect();
  const gap = px(style.rowGap || style.gap);
  const pageWidth = Math.round(innerRect.width);
  const pageHeight = Math.round(pageWidth * A4_RATIO);
  const margin = Math.max(px(style.paddingTop), 24);

  // 메시지 하나씩 찍는다. 목록 전체를 한 장으로 찍으면 긴 대화는 캔버스 한계를
  // 넘고, 쪽 경계에서 메시지를 온전히 넘길 수도 없다.
  const shots: { canvas: HTMLCanvasElement; x: number; width: number; height: number; ratio: number }[] = [];
  for (const block of blocks) {
    const rect = block.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const ratio = Math.min(PIXEL_RATIO, MAX_CANVAS_SIDE / rect.height, MAX_CANVAS_SIDE / rect.width);
    const canvas = await toCanvas(block, {
      pixelRatio: ratio,
      backgroundColor: background,
      // 찍는 순간의 크기를 고정한다. 복제본이 부모 없이 그려지면 폭이 달라져
      // 줄바꿈이 화면과 달라진다.
      width: rect.width,
      height: rect.height,
      cacheBust: false,
    });
    // x 는 본문 안에서의 가로 위치 — 화면의 좌우 안쪽 여백과 말풍선 정렬이 그대로 옮겨진다.
    shots.push({ canvas, x: rect.left - innerRect.left, width: rect.width, height: rect.height, ratio });
  }

  const { placements, pageCount } = layoutBlocks(
    shots.map((s) => s.height),
    { pageHeight, margin, gap },
    blankRowCutFinder(shots),
  );

  const pdf = new jsPDF({
    unit: "px",
    format: [pageWidth, pageHeight],
    orientation: "portrait",
    hotfixes: ["px_scaling"],
    compress: true,
  });
  const [r, g, b] = rgbOf(background);
  const paint = () => {
    pdf.setFillColor(r, g, b);
    pdf.rect(0, 0, pageWidth, pageHeight, "F");
  };
  for (let page = 0; page < pageCount; page++) {
    if (page > 0) pdf.addPage([pageWidth, pageHeight], "portrait");
    paint();
    for (const p of placements.filter((pl) => pl.page === page)) {
      const shot = shots[p.block]!;
      let source: HTMLCanvasElement = shot.canvas;
      if (p.sourceY !== 0 || p.height !== shot.height) {
        // 한 쪽보다 긴 메시지: 이 쪽에 들어갈 만큼만 잘라 낸다.
        source = document.createElement("canvas");
        source.width = shot.canvas.width;
        source.height = Math.max(1, Math.round(p.height * shot.ratio));
        source
          .getContext("2d")!
          .drawImage(shot.canvas, 0, Math.round(p.sourceY * shot.ratio), shot.canvas.width, source.height, 0, 0, source.width, source.height);
      }
      pdf.addImage(source, "PNG", shot.x, p.y, shot.width, p.height, undefined, "FAST");
    }
  }
  pdf.save(filename);
}
