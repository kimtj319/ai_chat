/**
 * 출처 단락을 원문 속에서 찾는다 — 오른쪽 창의 노란 강조가 붙을 자리.
 *
 * 단락(색인한 청크)과 원문이 글자 하나하나 같다는 보장은 없다. PDF 는 우리 추출기와
 * pdf.js 가 글자를 따로 꺼내므로 띄어쓰기·줄바꿈·따옴표 모양이 다르고, 마크다운
 * 문서는 청크에 # · * 같은 표시가 그대로 있다. 그래서
 *
 *   1. 양쪽을 같은 규칙으로 줄인다(공백·표시 문자 제거, 따옴표·대시 통일, NFKC).
 *   2. 단락을 문장으로 나눠 문장마다 찾는다. 한 문장이 어긋나도 나머지는 칠해진다.
 *
 * 돌려주는 범위는 **원문 글자 위치**다. 줄인 문자열의 위치는 원문 위치 표로 되돌린다.
 */

/** 원문에서 이 글자들은 비교할 때 없는 것으로 친다. */
const DROP = /[\s​-‍﻿#*`|>_~]/u;

const FOLD: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "−": "-",
  "·": "·",
};

export interface Normalized {
  text: string;
  /** text[i] 가 원문의 몇 번째 글자에서 왔는가. */
  origin: number[];
}

export function normalizeForMatch(input: string): Normalized {
  let text = "";
  const origin: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (DROP.test(ch)) continue;
    const folded = (FOLD[ch] ?? ch).normalize("NFKC").toLowerCase();
    for (const c of folded) {
      if (DROP.test(c)) continue;
      text += c;
      origin.push(i);
    }
  }
  return { text, origin };
}

/** 이보다 짧은 조각은 원문 여기저기서 우연히 걸리므로 찾지 않는다. */
const MIN_PIECE = 8;

/**
 * 단락을 문장 단위로 나눈다. 줄바꿈과 문장 끝 부호가 경계다.
 *
 * PDF 에서 온 단락의 줄바꿈은 대개 문장 중간의 줄넘김이라, 잘린 짧은 토막은 버리지
 * 않고 다음 토막에 붙인다 — 버리면 그 자리만 칠해지지 않아 형광펜이 끊긴다.
 */
export function piecesOf(passage: string): string[] {
  const out: string[] = [];
  let carry = "";
  for (const raw of passage.split(/\n+|(?<=[.!?。])\s+/u)) {
    const piece = `${carry} ${raw}`.trim();
    if (normalizeForMatch(piece).text.length < MIN_PIECE) {
      carry = piece;
      continue;
    }
    out.push(piece);
    carry = "";
  }
  // 마지막에 남은 짧은 토막은 앞 조각에 붙인다(단락 끝의 짧은 문장).
  if (carry && out.length > 0) out[out.length - 1] = `${out[out.length - 1]} ${carry}`;
  return out;
}

export interface Range {
  start: number;
  end: number;
}

/**
 * `haystack`(원문) 안에서 `passage` 의 문장들이 있는 곳. 원문 위치로, 겹치거나
 * 맞닿은 범위는 합친다.
 *
 * 같은 문장이 원문에 여러 번 나오면(머리말·목차·반복 문구) 아무 데나 칠하면 안 된다.
 * 단락은 원문의 한 곳에서 잘라 낸 것이니 그 문장들은 한곳에 모여 있어야 맞다. 그래서
 * 문장마다 원문에 나오는 자리를 모두 모은 뒤, **단락 길이 안에 가장 많은 문장(글자
 * 수로)이 제자리 근처에 함께 나오는 시작점**을 고르고 그 단락 길이 안에서만 칠한다.
 */
export function findPassage(haystack: string, passage: string): Range[] {
  const hay = normalizeForMatch(haystack);
  const needles = piecesOf(passage)
    .map((piece) => normalizeForMatch(piece).text)
    .filter((n) => n.length > 0);
  if (needles.length === 0) return [];
  const span = needles.reduce((n, s) => n + s.length, 0);

  const hits = needles.map((needle) => occurrences(hay.text, needle));
  // 단락 안에서 각 문장이 시작하는 위치(줄인 글자 기준).
  const offsets: number[] = [];
  needles.reduce((at, n) => (offsets.push(at), at + n.length), 0);

  // 후보: k 번째 문장이 원문의 candidate 에 있다면 단락은 candidate - offsets[k] 에서
  // 시작한다. 그 시작점부터 단락 길이 안에 다른 문장이 얼마나 제자리 근처에 오는지 센다.
  // 점수가 같으면 원문에 적게 나오는 문장에서 나온 후보를 믿는다 — "10. …" 처럼
  // 한 번만 나오는 문장의 위치가 반복 문장의 어느 사본보다 확실하다.
  let best: { start: number; score: number; rarity: number } | null = null;
  hits.forEach((list, k) => {
    for (const candidate of list) {
      const start = Math.max(0, candidate - offsets[k]!);
      const lo = Math.max(0, start - SLACK);
      const hi = start + span + SLACK;
      let score = 0;
      hits.forEach((occ, i) => {
        if (occ.some((at) => at >= lo && at <= hi)) score += needles[i]!.length;
      });
      const rarity = -list.length;
      if (!best || score > best.score || (score === best.score && rarity > best.rarity)) best = { start, score, rarity };
    }
  });
  if (!best) return [];
  const { start } = best;
  const lo = Math.max(0, start - SLACK);
  const hi = start + span + SLACK;

  const ranges: Range[] = [];
  let from = lo;
  needles.forEach((needle, i) => {
    const inWindow = hits[i]!.filter((at) => at >= lo && at <= hi);
    const at = inWindow.find((x) => x >= from) ?? inWindow[0];
    if (at === undefined) return;
    from = at + needle.length;
    ranges.push({ start: hay.origin[at]!, end: hay.origin[at + needle.length - 1]! + 1 });
  });
  ranges.sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    // 사이에 공백·표시 문자만 있으면 한 덩어리로 칠한다(줄글처럼 이어지게).
    if (last && (r.start <= last.end || !haystack.slice(last.end, r.start).split("").some((c) => !DROP.test(c)))) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** 추출기마다 글자가 조금씩 빠지거나 더해지므로, 단락 위치 추정에 두는 여유. */
const SLACK = 40;

/** 원문에서 `needle` 이 나오는 모든 자리(너무 흔하면 앞에서부터 일부만). */
function occurrences(text: string, needle: string, limit = 50): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(needle); at >= 0 && out.length < limit; at = text.indexOf(needle, at + 1)) out.push(at);
  return out;
}

/** 칠해진 원문 글자 수 — 여러 쪽 가운데 단락이 있는 쪽을 고를 때 쓴다. */
export function coverage(ranges: Range[]): number {
  return ranges.reduce((n, r) => n + (r.end - r.start), 0);
}
