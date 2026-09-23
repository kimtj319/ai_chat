/**
 * PDF 쪽 나누기. 화면에서 찍은 메시지 블록(높이만 안다)을 쪽에 배치한다.
 *
 * 규칙:
 *   - 블록은 가능하면 쪽 경계에서 잘리지 않는다. 남은 자리에 안 들어가면 다음
 *     쪽 맨 위로 넘긴다 — 한 메시지가 두 쪽에 걸쳐 반씩 보이는 것은 화면에는
 *     없는 모습이다.
 *   - 한 쪽보다 큰 블록(긴 답변)만 어쩔 수 없이 쪽마다 잘라서 이어 붙인다.
 *     이런 블록은 어차피 잘리므로 지금 쪽에 자리가 넉넉하면 거기서 바로 시작한다
 *     — 새 쪽으로 넘기면 앞 쪽 아래가 통째로 빈다.
 *   - 자르는 자리는 `cut` 이 고른다(글줄 사이 빈 줄로 당기는 일). 없으면 쪽 끝에서 자른다.
 *
 * 단위는 CSS px 이다. 화면 배치를 그대로 옮기는 것이 목적이라 mm 로 바꾸지 않는다.
 */

export interface PagePlacement {
  /** 몇 번째 블록인지. */
  block: number;
  page: number;
  /** 쪽 위쪽 끝에서 이 조각을 그릴 y. */
  y: number;
  /** 블록 안에서 이 조각이 시작하는 y 와 그 높이. 잘리지 않았으면 0 과 블록 높이. */
  sourceY: number;
  height: number;
}

export interface PageGeometry {
  /** 쪽 전체 높이. */
  pageHeight: number;
  /** 위·아래 여백. */
  margin: number;
  /** 블록 사이 간격 — 화면의 flex gap. */
  gap: number;
}

/** 큰 블록을 이 비율 이상 남은 쪽에서는 이어서 시작한다. */
const OVERSIZE_START_RATIO = 0.2;
/** 자르는 자리를 당겨도 이만큼은 채운다. 빈 줄을 못 찾아 쪽이 텅 비는 것을 막는다. */
const MIN_SLICE_RATIO = 0.5;

/**
 * 블록 `block` 을 `sourceY` 부터 최대 `maxSlice` 만큼 담을 때 실제로 담을 높이.
 * 글줄 한가운데를 자르지 않도록 조금 짧게 돌려줄 수 있다.
 */
export type CutFinder = (block: number, sourceY: number, maxSlice: number) => number;

export function layoutBlocks(
  heights: number[],
  geo: PageGeometry,
  cut: CutFinder = (_b, _y, max) => max,
): { placements: PagePlacement[]; pageCount: number } {
  const usable = geo.pageHeight - geo.margin * 2;
  if (usable <= 0) throw new Error("쪽 높이가 여백보다 작습니다.");
  const placements: PagePlacement[] = [];
  let page = 0;
  // 이 쪽에서 다음 블록을 놓을 y. 쪽 맨 위면 margin.
  let cursor = geo.margin;
  const atTop = () => cursor === geo.margin;

  heights.forEach((rawHeight, block) => {
    const height = Math.max(0, rawHeight);
    if (height === 0) return;
    // 쪽 맨 위가 아니면 블록 앞에 간격을 둔다.
    const start = atTop() ? cursor : cursor + geo.gap;
    if (start + height <= geo.pageHeight - geo.margin) {
      placements.push({ block, page, y: start, sourceY: 0, height });
      cursor = start + height;
      return;
    }
    // 새 쪽에 통째로 들어가면 넘긴다.
    if (height <= usable) {
      if (!atTop()) page++;
      placements.push({ block, page, y: geo.margin, sourceY: 0, height });
      cursor = geo.margin + height;
      return;
    }
    // 한 쪽보다 크다. 남은 자리가 넉넉하면 이 쪽에서, 아니면 새 쪽에서 시작해 쪽마다 자른다.
    let y = start;
    if (geo.pageHeight - geo.margin - start < usable * OVERSIZE_START_RATIO) {
      if (!atTop()) page++;
      y = geo.margin;
    }
    let sourceY = 0;
    while (sourceY < height) {
      const room = geo.pageHeight - geo.margin - y;
      let slice = room;
      if (height - sourceY <= room) {
        slice = height - sourceY;
      } else {
        const chosen = cut(block, sourceY, room);
        slice = chosen >= room * MIN_SLICE_RATIO && chosen <= room ? chosen : room;
      }
      placements.push({ block, page, y, sourceY, height: slice });
      sourceY += slice;
      cursor = y + slice;
      if (sourceY < height) {
        page++;
        y = geo.margin;
      }
    }
  });

  return { placements, pageCount: placements.length === 0 ? 0 : page + 1 };
}
