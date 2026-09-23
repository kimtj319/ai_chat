import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { coverage, findPassage } from "../state/highlightMatch";

/**
 * 출처 창의 PDF 그리기. 이 파일은 출처를 처음 열 때만 받아 온다(pdf.js 가 크다).
 *
 * 순서:
 *   1. 모든 쪽의 글자를 꺼내 단락이 가장 많이 걸리는 쪽을 찾는다.
 *   2. 쪽마다 크기만 잡은 빈 칸을 깔고, 그 쪽을 먼저 그린 뒤 그리로 스크롤한다.
 *   3. 나머지 쪽은 화면에 가까워질 때 그린다 — 수백 쪽을 한꺼번에 그리면 창이 굳는다.
 *
 * 강조는 pdf.js 의 글자층(보이지 않는 글자 span 들) 위에 칠한다. 글자는 캔버스가
 * 그리고, 노란 배경만 그 위에 곱하기(multiply)로 얹어 형광펜처럼 보이게 한다.
 */

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const CMAP_URL = "/pdfjs/cmaps/";
const STANDARD_FONT_URL = "/pdfjs/standard_fonts/";

export interface PdfRenderResult {
  /** 단락을 찾았는가. 못 찾으면 첫 쪽을 보여 준다. */
  found: boolean;
  page: number;
  pages: number;
}

interface TextItemLike {
  str?: string;
}

function pageText(items: readonly unknown[]): string {
  return items.map((it) => (it as TextItemLike).str ?? "").join("");
}

/** 글자층의 span 들에 단락 범위를 칠한다. 칠한 첫 요소를 돌려준다. */
function paint(textLayer: pdfjs.TextLayer, passage: string): HTMLElement | null {
  const strs = textLayer.textContentItemsStr;
  const divs = textLayer.textDivs;
  const starts: number[] = [];
  let joined = "";
  for (const s of strs) {
    starts.push(joined.length);
    joined += s;
  }
  let first: HTMLElement | null = null;
  for (const range of findPassage(joined, passage)) {
    for (let i = 0; i < divs.length; i++) {
      const div = divs[i]!;
      const len = strs[i]!.length;
      const s = Math.max(range.start, starts[i]!) - starts[i]!;
      const e = Math.min(range.end, starts[i]! + len) - starts[i]!;
      if (s >= e) continue;
      let mark: HTMLElement;
      if (s === 0 && e === len) {
        div.classList.add("source-hl");
        mark = div;
      } else {
        // 한 span 의 일부만 걸리면 그 부분만 감싼다.
        const text = strs[i]!;
        div.textContent = "";
        if (s > 0) div.append(text.slice(0, s));
        mark = document.createElement("span");
        mark.className = "source-hl source-hl-part";
        mark.textContent = text.slice(s, e);
        div.append(mark);
        if (e < len) div.append(text.slice(e));
      }
      first ??= mark;
    }
  }
  return first;
}

export async function renderPdf(
  host: HTMLElement,
  data: ArrayBuffer,
  passage: string,
  signal: AbortSignal,
): Promise<PdfRenderResult> {
  const task = pdfjs.getDocument({
    data,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_URL,
    isEvalSupported: false,
  });
  signal.addEventListener("abort", () => void task.destroy(), { once: true });
  const doc = await task.promise;

  // 1. 단락이 있는 쪽 찾기.
  const scores: number[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    if (signal.aborted) return { found: false, page: 1, pages: doc.numPages };
    const page = await doc.getPage(n);
    const text = pageText((await page.getTextContent()).items);
    scores.push(coverage(findPassage(text, passage)));
  }
  const bestScore = Math.max(0, ...scores);
  const best = bestScore > 0 ? scores.indexOf(bestScore) + 1 : 1;
  // 단락이 쪽 경계에 걸치면 이웃 쪽에도 일부가 있다. 가장 잘 맞는 쪽이 단락을 거의
  // 다 담았으면 그 쪽만 칠한다 — 비슷한 문장이 되풀이되는 문서에서 옆 쪽의 사본까지
  // 칠해지는 것을 막는다.
  const passageChars = passage.replace(/\s+/g, "").length;
  const spills = bestScore < passageChars * 0.7;
  const paintPages = new Set(
    scores
      .map((score, i) => ({ score, n: i + 1 }))
      .filter(({ score, n }) => n === best || (spills && score > 0 && Math.abs(n - best) <= 1))
      .map(({ n }) => n),
  );

  // 2. 쪽 칸 깔기. 너비는 창에 맞추고, 높이는 쪽마다 비율대로.
  host.textContent = "";
  const width = host.clientWidth - 32;
  const dpr = window.devicePixelRatio || 1;
  const slots: { n: number; el: HTMLDivElement; scale: number; drawn: boolean }[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const el = document.createElement("div");
    el.className = "source-pdf-page";
    el.style.width = `${Math.floor(base.width * scale)}px`;
    el.style.height = `${Math.floor(base.height * scale)}px`;
    el.style.setProperty("--scale-factor", String(scale));
    el.dataset.page = String(n);
    host.append(el);
    slots.push({ n, el, scale, drawn: false });
  }

  async function draw(slot: (typeof slots)[number]): Promise<HTMLElement | null> {
    if (slot.drawn || signal.aborted) return null;
    slot.drawn = true;
    const page = await doc.getPage(slot.n);
    const viewport = page.getViewport({ scale: slot.scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    slot.el.append(canvas);
    await page.render({
      canvasContext: canvas.getContext("2d")!,
      viewport,
      transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
    }).promise;
    const layer = document.createElement("div");
    layer.className = "textLayer";
    slot.el.append(layer);
    const textLayer = new pdfjs.TextLayer({ textContentSource: await page.getTextContent(), container: layer, viewport });
    await textLayer.render();
    return paintPages.has(slot.n) ? paint(textLayer, passage) : null;
  }

  // 3. 찾은 쪽을 먼저 그리고 그리로 간다. 강조가 있으면 그것이 창 위쪽 1/3 에 오게.
  const target = slots[best - 1]!;
  host.scrollTop = target.el.offsetTop - 16;
  const mark = await draw(target);
  if (mark && !signal.aborted) {
    const m = mark.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    host.scrollTop += m.top - h.top - h.height / 3;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const slot = slots[Number((entry.target as HTMLElement).dataset.page) - 1];
        if (slot) void draw(slot);
      }
    },
    { root: host, rootMargin: "600px 0px" },
  );
  for (const slot of slots) observer.observe(slot.el);
  signal.addEventListener("abort", () => observer.disconnect(), { once: true });

  return { found: bestScore > 0, page: best, pages: doc.numPages };
}
