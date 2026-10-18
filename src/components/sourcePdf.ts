import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { appPath } from "../api/base";
import { coverage, findPassage } from "../state/highlightMatch";
import type { CachedPdf, PdfPlacement } from "../state/sourceCache";

/**
 * 출처 창의 PDF 그리기. 이 파일은 출처를 처음 열 때만 받아 온다(pdf.js 가 크다).
 *
 * 처음 열 때(loadPdf):
 *   1. 모든 쪽의 글자를 꺼내 둔다 — 단락이 어느 쪽에 있는지 찾는 데 쓴다.
 *   2. 쪽마다 크기만 잡은 빈 칸을 깐다. 쪽은 화면에 가까워질 때 그린다 — 수백 쪽을
 *      한꺼번에 그리면 창이 굳는다.
 *
 * 그렇게 만든 한 벌(PdfView)은 state/sourceCache.ts 에 남는다. 같은 문서의 다른 단락을
 * 누르면(show) 앞 강조만 지우고 새 단락을 칠한 뒤 그리로 스크롤한다 — 다시 받지도,
 * 다시 그리지도 않는다. 다른 문서를 보다 돌아와도 스크롤 칸째로 옮겨 붙인다(attach).
 *
 * 강조는 pdf.js 의 글자층(보이지 않는 글자 span 들) 위에 칠한다. 글자는 캔버스가
 * 그리고, 노란 배경만 그 위에 곱하기(multiply)로 얹어 형광펜처럼 보이게 한다.
 */

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// 앱 루트 기준(api/base.ts) — 다른 도메인의 하위 경로로 연결돼도 찾아간다.
const CMAP_URL = appPath("pdfjs/cmaps/");
const STANDARD_FONT_URL = appPath("pdfjs/standard_fonts/");

/**
 * 붙잡아 두는 캔버스 수. 모든 문서를 통틀어 센다. 쪽 하나가 창 폭·화면 배율에 따라
 * 수 MB~십수 MB 라, 문서 네 벌을 남겨 두면서 그린 쪽까지 다 남기면 메모리가 끝없이 는다.
 * 넘으면 오래 안 본 문서의 쪽부터, 그다음 보는 문서에서 가장 먼 쪽부터 놓는다 — 놓은
 * 쪽은 다시 화면에 가까워지면 그린다.
 */
const MAX_DRAWN_PAGES = 24;

interface TextItemLike {
  str?: string;
}

function pageText(items: readonly unknown[]): string {
  return items.map((it) => (it as TextItemLike).str ?? "").join("");
}

interface Slot {
  n: number;
  el: HTMLDivElement;
  scale: number;
  /** 그리는 중이거나 다 그렸으면 그 약속. 놓으면 null 로 돌아간다. */
  drawing: Promise<pdfjs.TextLayer | null> | null;
  /** 다 그린 글자층. */
  layer: pdfjs.TextLayer | null;
  /** 몇 번째 show 의 단락으로 칠했는가. */
  paintedFor: number;
}

/** 지금 살아 있는 PDF 들. 캔버스 수를 문서를 통틀어 묶는 데 쓴다. */
const live = new Set<PdfView>();
let clock = 0;

class PdfView implements CachedPdf {
  readonly pages: number;
  usedAt = ++clock;
  private readonly slots: Slot[] = [];
  private readonly observer: IntersectionObserver;
  /** 칠하느라 바꾼 글자 span 과 원래 글. 다음 단락을 칠하기 전에 되돌린다. */
  private painted: Array<{ div: HTMLElement; text: string }> = [];
  private passage = "";
  private paintPages = new Set<number>();
  private target = 1;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly doc: pdfjs.PDFDocumentProxy,
    private readonly texts: string[],
    private readonly scroller: HTMLDivElement,
    sizes: Array<{ width: number; height: number }>,
  ) {
    this.pages = doc.numPages;
    // 너비는 창에 맞추고, 높이는 쪽마다 비율대로.
    const width = scroller.clientWidth - 32;
    sizes.forEach((size, i) => {
      const scale = width / size.width;
      const el = document.createElement("div");
      el.className = "source-pdf-page";
      el.style.width = `${Math.floor(size.width * scale)}px`;
      el.style.height = `${Math.floor(size.height * scale)}px`;
      el.style.setProperty("--scale-factor", String(scale));
      el.dataset.page = String(i + 1);
      scroller.append(el);
      this.slots.push({ n: i + 1, el, scale, drawing: null, layer: null, paintedFor: 0 });
    });
    // 스크롤 칸째로 남기므로 떼었다 다시 붙여도 이 관찰자가 그대로 산다. 떼어 둔 동안은 보이는 것이 없어 조용하다.
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const slot = this.slots[Number((entry.target as HTMLElement).dataset.page) - 1];
          if (slot) void this.drawAndPaint(slot);
        }
      },
      { root: scroller, rootMargin: "600px 0px" },
    );
    for (const slot of this.slots) this.observer.observe(slot.el);
    live.add(this);
  }

  attach(host: HTMLElement): void {
    this.usedAt = ++clock;
    if (this.scroller.parentElement !== host) host.append(this.scroller);
  }

  show(passage: string): PdfPlacement {
    this.usedAt = ++clock;
    this.unpaint();
    const generation = ++this.generation;

    // 단락이 있는 쪽 찾기.
    const scores = this.texts.map((text) => coverage(findPassage(text, passage)));
    const bestScore = Math.max(0, ...scores);
    const best = bestScore > 0 ? scores.indexOf(bestScore) + 1 : 1;
    // 단락이 쪽 경계에 걸치면 이웃 쪽에도 일부가 있다. 가장 잘 맞는 쪽이 단락을 거의
    // 다 담았으면 그 쪽만 칠한다 — 비슷한 문장이 되풀이되는 문서에서 옆 쪽의 사본까지
    // 칠해지는 것을 막는다.
    const passageChars = passage.replace(/\s+/g, "").length;
    const spills = bestScore < passageChars * 0.7;
    this.paintPages = new Set(
      scores
        .map((score, i) => ({ score, n: i + 1 }))
        .filter(({ score, n }) => n === best || (spills && score > 0 && Math.abs(n - best) <= 1))
        .map(({ n }) => n),
    );
    this.passage = passage;
    this.target = best;

    // 찾은 쪽으로 간다. 이미 그려져 있으면 그 자리에서 칠하고, 강조가 창 위쪽 1/3 에 오게.
    for (const n of this.paintPages) this.paintSlot(this.slots[n - 1]!);
    const target = this.slots[best - 1]!;
    this.scroller.scrollTop = target.el.offsetTop - 16;
    if (target.layer) this.scrollToMark();
    else
      void this.drawAndPaint(target).then(() => {
        // 그사이 다른 단락을 눌렀으면 그 단락의 show 가 스크롤을 맡는다.
        if (generation === this.generation) this.scrollToMark();
      });
    return { found: bestScore > 0, page: best, pages: this.pages };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    live.delete(this);
    this.observer.disconnect();
    for (const slot of this.slots) this.release(slot);
    this.scroller.remove();
    void this.doc.destroy();
  }

  drawnCount(): number {
    return this.slots.filter((s) => s.layer).length;
  }

  /** 놓아도 되는 다 그린 쪽들, 지금 보는 쪽에서 먼 것부터. 칠할 쪽과 `keep` 은 빼고. */
  releasable(keep: Slot | null): Slot[] {
    return this.slots
      .filter((s) => s.layer && s !== keep && !this.paintPages.has(s.n))
      .sort((a, b) => Math.abs(b.n - this.target) - Math.abs(a.n - this.target));
  }

  release(slot: Slot): void {
    if (!slot.drawing) return;
    for (const canvas of slot.el.querySelectorAll("canvas")) {
      // 크기를 0 으로 해야 캔버스의 메모리가 바로 풀린다(떼어 낸 요소도 참조가 남으면 산다).
      canvas.width = 0;
      canvas.height = 0;
    }
    slot.layer?.cancel();
    this.painted = this.painted.filter((p) => !slot.el.contains(p.div));
    slot.el.textContent = "";
    slot.drawing = null;
    slot.layer = null;
    slot.paintedFor = 0;
  }

  private scrollToMark(): void {
    const mark = this.scroller.querySelector(`[data-page="${this.target}"] .source-hl`);
    if (!mark) return;
    const m = mark.getBoundingClientRect();
    const h = this.scroller.getBoundingClientRect();
    this.scroller.scrollTop += m.top - h.top - h.height / 3;
  }

  private async drawAndPaint(slot: Slot): Promise<void> {
    if (await this.draw(slot)) this.paintSlot(slot);
  }

  private draw(slot: Slot): Promise<pdfjs.TextLayer | null> {
    if (slot.drawing) return slot.drawing;
    const drawing: Promise<pdfjs.TextLayer | null> = (async () => {
      const page = await this.doc.getPage(slot.n);
      const viewport = page.getViewport({ scale: slot.scale });
      const dpr = window.devicePixelRatio || 1;
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
      const container = document.createElement("div");
      container.className = "textLayer";
      slot.el.append(container);
      const textLayer = new pdfjs.TextLayer({ textContentSource: await page.getTextContent(), container, viewport });
      await textLayer.render();
      if (this.disposed) return null;
      slot.layer = textLayer;
      trimCanvases(this, slot);
      return textLayer;
    })().catch((err: unknown) => {
      // 버린 문서의 그리기는 pdf.js 가 끊으며 오류로 끝난다. 그 밖의 것은 다음에 다시 그리게 둔다.
      if (this.disposed) return null;
      console.warn("[source] could not draw a PDF page:", err);
      this.release(slot);
      return null;
    });
    slot.drawing = drawing;
    return drawing;
  }

  /** 이 쪽에 지금 단락을 칠한다. 칠할 쪽이 아니거나, 아직 안 그렸거나, 이번 단락으로 이미 칠했으면 그만둔다. */
  private paintSlot(slot: Slot): void {
    if (!slot.layer || !this.paintPages.has(slot.n) || slot.paintedFor === this.generation) return;
    slot.paintedFor = this.generation;
    this.painted.push(...paint(slot.layer, this.passage));
  }

  private unpaint(): void {
    for (const { div, text } of this.painted) {
      div.classList.remove("source-hl");
      div.textContent = text;
    }
    this.painted = [];
  }
}

/** 그린 쪽이 한도를 넘으면 놓는다. 오래 안 본 문서의 쪽부터, 그다음 지금 문서에서 먼 쪽부터. */
function trimCanvases(current: PdfView, justDrawn: Slot): void {
  let total = 0;
  for (const view of live) total += view.drawnCount();
  if (total <= MAX_DRAWN_PAGES) return;
  const others = [...live].filter((v) => v !== current).sort((a, b) => a.usedAt - b.usedAt);
  for (const view of [...others, current]) {
    for (const slot of view.releasable(view === current ? justDrawn : null)) {
      if (total <= MAX_DRAWN_PAGES) return;
      view.release(slot);
      total--;
    }
  }
}

/** 글자층의 span 들에 단락 범위를 칠한다. 바꾼 span 과 원래 글을 돌려준다(되돌리기용). */
function paint(textLayer: pdfjs.TextLayer, passage: string): Array<{ div: HTMLElement; text: string }> {
  const strs = textLayer.textContentItemsStr;
  const divs = textLayer.textDivs;
  const starts: number[] = [];
  let joined = "";
  for (const s of strs) {
    starts.push(joined.length);
    joined += s;
  }
  const changed: Array<{ div: HTMLElement; text: string }> = [];
  for (const range of findPassage(joined, passage)) {
    for (let i = 0; i < divs.length; i++) {
      const div = divs[i]!;
      const text = strs[i]!;
      const len = text.length;
      const s = Math.max(range.start, starts[i]!) - starts[i]!;
      const e = Math.min(range.end, starts[i]! + len) - starts[i]!;
      if (s >= e) continue;
      changed.push({ div, text });
      if (s === 0 && e === len) {
        div.classList.add("source-hl");
      } else {
        // 한 span 의 일부만 걸리면 그 부분만 감싼다.
        div.textContent = "";
        if (s > 0) div.append(text.slice(0, s));
        const mark = document.createElement("span");
        mark.className = "source-hl source-hl-part";
        mark.textContent = text.slice(s, e);
        div.append(mark);
        if (e < len) div.append(text.slice(e));
      }
    }
  }
  return changed;
}

/**
 * PDF 를 받아 쪽 칸을 깔고 `host` 에 붙인다. 다 되기 전에 끊기면(signal) pdf.js 문서를
 * 버리고 null — 그 사이 다른 출처로 넘어갔으면 이 창에 아무것도 그리지 않는다.
 * 다 된 것은 그 뒤에 끊겨도 돌려준다: 캐시에 넣어 두면 다시 눌렀을 때 바로 열린다.
 */
export async function loadPdf(host: HTMLElement, data: ArrayBuffer, signal: AbortSignal): Promise<CachedPdf | null> {
  const task = pdfjs.getDocument({
    data,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_URL,
    isEvalSupported: false,
  });
  const abandon = () => void task.destroy();
  signal.addEventListener("abort", abandon, { once: true });
  try {
    const doc = await task.promise;
    const texts: string[] = [];
    const sizes: Array<{ width: number; height: number }> = [];
    for (let n = 1; n <= doc.numPages; n++) {
      if (signal.aborted) return null;
      const page = await doc.getPage(n);
      texts.push(pageText((await page.getTextContent()).items));
      const base = page.getViewport({ scale: 1 });
      sizes.push({ width: base.width, height: base.height });
    }
    if (signal.aborted) return null;
    const scroller = document.createElement("div");
    scroller.className = "source-pdf";
    // 폭을 재려면 붙어 있어야 한다.
    host.append(scroller);
    return new PdfView(doc, texts, scroller, sizes);
  } catch (err) {
    if (signal.aborted) return null;
    throw err;
  } finally {
    signal.removeEventListener("abort", abandon);
  }
}
