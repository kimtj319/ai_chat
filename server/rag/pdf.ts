/**
 * PDF 에서 글자를 뽑는다. 의존성 없이 Node 내장 zlib 만 쓴다.
 *
 * 한국어 PDF 가 "0자" 로 나오던 이유는 여기 있다. 본문 스트림의 바이트는
 * 글자 코드가 아니라 **글리프 번호**다 — 한컴이나 워드가 폰트를 부분집합으로
 * 임베드하면서 매긴 번호라, 그대로 읽으면 뜻 없는 바이트열이 된다. 그 번호를
 * 유니코드로 되돌리는 표가 폰트마다 붙은 `/ToUnicode` 이고, 그걸 읽지 않는
 * 추출기는 글자가 멀쩡히 든 문서에서도 아무것도 못 얻는다.
 *
 * 코드 폭도 폰트가 정한다. `/Subtype /Type0` 은 두 바이트가 한 글자이고
 * 나머지는 한 바이트다. 이걸 CMap 키 길이로 넘겨짚으면, 한 문서 안에 두
 * 종류가 섞였을 때(흔하다) 한쪽이 통째로 빈 결과가 된다 — 실제로 그렇게
 * 0자가 나왔다.
 */
import zlib from "node:zlib";

interface PdfObject {
  dict: string;
  stream: Buffer | null;
}

interface PdfFont {
  map: Map<number, string>;
  /** 한 글자를 이루는 바이트 수. Type0(CID) 는 2, 나머지는 1. */
  width: 1 | 2;
  /**
   * 글자 코드 → 폭(em 의 1/1000). 이게 있어야 "여기 빈칸이 있었다" 를
   * 추정이 아니라 계산으로 가를 수 있다. 표가 없는 글꼴이면 비어 있고,
   * 그때는 글자 종류로 어림한다.
   */
  widths: Map<number, number>;
  /** 표에 없는 코드의 폭. CID 글꼴은 /DW, 단순 글꼴은 /MissingWidth. */
  defaultWidth: number;
}

/* ------------------------------------------------------------------ 객체 훑기 */

/**
 * 파일을 훑어 `N G obj … endobj` 를 모은다.
 *
 * xref 표를 따라가지 않는다. 그 표는 깨졌거나(흔하다), 점진 갱신으로 여러
 * 벌이거나, xref 스트림(PDF 1.5+)이다. 객체 자체는 어느 경우에도 파일 안에
 * 그대로 있으므로 훑는 쪽이 더 많은 파일에서 동작한다.
 */
function scanObjects(buf: Buffer): Map<string, PdfObject> {
  const objects = new Map<string, PdfObject>();
  const text = buf.toString("latin1");
  const re = /(?:^|[\s>])(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length;
    const end = text.indexOf("endobj", start);
    if (end < 0) continue;
    const streamAt = text.indexOf("stream", start);
    const hasStream = streamAt >= 0 && streamAt < end;
    const dict = text.slice(start, hasStream ? streamAt : end);
    let stream: Buffer | null = null;
    if (hasStream) {
      let s = streamAt + "stream".length;
      if (text[s] === "\r") s++;
      if (text[s] === "\n") s++;
      // /Length 를 먼저 믿는다. 본문에 "endstream" 과 같은 바이트열이 들어
      // 있을 수 있어서, 문자열 검색만으로는 스트림을 짧게 자를 수 있다.
      const len = /\/Length\s+(\d+)(?!\s+\d+\s*R)/.exec(dict);
      let e = -1;
      if (len) {
        const cand = s + Number(len[1]);
        if (cand <= text.length && /^\s*endstream/.test(text.slice(cand, cand + 12))) e = cand;
      }
      if (e < 0) {
        e = text.indexOf("endstream", s);
        if (e > s) {
          if (text[e - 1] === "\n") e--;
          if (text[e - 1] === "\r") e--;
        }
      }
      if (e > s) stream = buf.subarray(s, e);
    }
    objects.set(`${m[1]} ${m[2]}`, { dict, stream });
  }
  return objects;
}

/** 스트림의 필터를 푼다. 못 푸는 필터(이미지 등)는 null. */
function decode(dict: string, stream: Buffer | null): Buffer | null {
  if (!stream) return null;
  const filter = /\/Filter\s*(\/\w+|\[[^\]]*\])/.exec(dict);
  const name = filter ? filter[1] : "";
  if (!name) return stream;
  if (!name.includes("FlateDecode")) return null;
  try {
    return zlib.inflateSync(stream);
  } catch {
    try {
      // 끝이 잘린 스트림이 흔하다. 거기까지라도 쓴다.
      return zlib.inflateSync(stream, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch {
      try {
        return zlib.inflateRawSync(stream.subarray(1), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } catch {
        return null;
      }
    }
  }
}

/** 객체 스트림(PDF 1.5+) 안의 객체를 꺼내 같은 표에 합친다. 요즘 파일은 폰트가 대부분 여기 있다. */
function expandObjectStreams(objects: Map<string, PdfObject>): Map<string, PdfObject> {
  for (const [, obj] of [...objects]) {
    if (!/\/Type\s*\/ObjStm/.test(obj.dict)) continue;
    const data = decode(obj.dict, obj.stream);
    if (!data) continue;
    const n = Number(/\/N\s+(\d+)/.exec(obj.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(obj.dict)?.[1] ?? 0);
    const head = data.subarray(0, first).toString("latin1").trim().split(/\s+/).map(Number);
    const body = data.subarray(first).toString("latin1");
    for (let i = 0; i < n; i++) {
      const num = head[i * 2];
      const off = head[i * 2 + 1];
      if (!Number.isFinite(num) || !Number.isFinite(off)) continue;
      const nextOff = i + 1 < n ? head[i * 2 + 3] : body.length;
      const dict = body.slice(off, Number.isFinite(nextOff) ? nextOff : body.length);
      if (!objects.has(`${num} 0`)) objects.set(`${num} 0`, { dict, stream: null });
    }
  }
  return objects;
}

/** `12 0 R` 을 따라간다. 값이 직접 쓰여 있으면 그대로 돌려준다. */
function resolve(objects: Map<string, PdfObject>, value: string | null): string {
  const ref = /^\s*(\d+)\s+(\d+)\s*R\s*$/.exec(value ?? "");
  if (!ref) return value ?? "";
  return objects.get(`${ref[1]} ${ref[2]}`)?.dict ?? "";
}

/** 사전에서 키 하나의 값을 떼어 온다. 중첩 `<< >>` 와 `[ ]` 를 센다. */
function dictValue(dict: string, key: string): string | null {
  const at = dict.indexOf(`/${key}`);
  if (at < 0) return null;
  let i = at + key.length + 1;
  while (i < dict.length && /\s/.test(dict[i])) i++;
  if (dict[i] === "<" && dict[i + 1] === "<") {
    let depth = 0;
    const start = i;
    for (; i < dict.length - 1; i++) {
      if (dict[i] === "<" && dict[i + 1] === "<") { depth++; i++; }
      else if (dict[i] === ">" && dict[i + 1] === ">") { depth--; i++; if (depth === 0) return dict.slice(start, i + 1); }
    }
    return dict.slice(start);
  }
  if (dict[i] === "[") {
    let depth = 0;
    const start = i;
    for (; i < dict.length; i++) {
      if (dict[i] === "[") depth++;
      else if (dict[i] === "]") { depth--; if (depth === 0) return dict.slice(start, i + 1); }
    }
    return dict.slice(start);
  }
  const rest = dict.slice(i);
  const m = /^(\d+\s+\d+\s*R|\/[^\s/<>[\]()]+|[-\d.]+|true|false)/.exec(rest);
  return m ? m[1] : null;
}

/* -------------------------------------------------------------- ToUnicode CMap */

function hexToStr(hex: string): string {
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 4) {
    const code = parseInt(hex.slice(i, i + 4), 16);
    if (Number.isFinite(code)) out += String.fromCharCode(code);
  }
  return out;
}

/**
 * `/ToUnicode` CMap 을 코드→글자 표로 바꾼다.
 *
 * `beginbfchar` 는 코드 하나씩, `beginbfrange` 는 구간이다. 구간의 오른쪽이
 * 배열이면 코드마다 다른 글자를, 단일 값이면 1씩 늘려 가며 매긴다 — 한글
 * 부분집합 폰트가 주로 쓰는 쪽이다.
 */
function parseToUnicode(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(parseInt(m[1], 16), hexToStr(m[2]));
    }
  }
  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(m[1], 16);
      [...m[3].matchAll(/<([0-9A-Fa-f]*)>/g)].forEach((it, i) => map.set(lo + i, hexToStr(it[1])));
    }
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      const dst = parseInt(m[3].slice(0, 4), 16);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 65535) continue;
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(dst + (c - lo)));
    }
  }
  return map;
}

/** 폰트 하나를 읽는다. 코드 폭은 CMap 이 아니라 폰트 종류가 정한다. */
/**
 * CID 글꼴의 `/W` 배열. 두 가지 모양이 섞여 있다.
 *
 *   c [w w w …]      c 부터 차례로
 *   cFirst cLast w   그 구간 전부 같은 폭
 */
function parseW(raw: string): Map<number, number> {
  const widths = new Map<number, number>();
  // 바깥 대괄호를 먼저 벗긴다. 안 벗기면 아래 정규식이 바깥 `[` 부터 **첫**
  // `]` 까지를 하나의 배열로 집어삼켜 첫 묶음이 통째로 어긋난다 — 그러면
  // 낮은 코드(공백·하이픈)가 표에서 사라지고 DW(보통 1000)로 떨어진다.
  const body = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  // 배열과 수를 순서대로 읽는다. 앞의 수가 무엇을 뜻하는지는 그 다음이 정한다.
  const re = /(\[[^\]]*\])|(-?\d*\.?\d+)/g;
  const items: Array<number | number[]> = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    if (m[1]) items.push(m[1].slice(1, -1).trim().split(/\s+/).filter(Boolean).map(Number));
    else items.push(Number(m[2]));
  }
  for (let i = 0; i < items.length; ) {
    const first = items[i];
    const next = items[i + 1];
    if (typeof first === "number" && Array.isArray(next)) {
      next.forEach((w, k) => widths.set(first + k, w));
      i += 2;
    } else if (typeof first === "number" && typeof next === "number" && typeof items[i + 2] === "number") {
      const w = items[i + 2] as number;
      // 구간이 터무니없이 길면 망가진 표다. 통째로 채우다 메모리를 태우지 않는다.
      if (next >= first && next - first <= 65535) for (let c = first; c <= next; c++) widths.set(c, w);
      i += 3;
    } else {
      i += 1;
    }
  }
  return widths;
}

function readFont(objects: Map<string, PdfObject>, fontDict: string): PdfFont {
  const subtype = dictValue(fontDict, "Subtype") ?? "";
  const isCID = subtype.includes("Type0");
  const tuRef = dictValue(fontDict, "ToUnicode");
  let map = new Map<number, string>();
  if (tuRef) {
    const ref = /^\s*(\d+)\s+(\d+)\s*R/.exec(tuRef);
    const obj = ref ? objects.get(`${ref[1]} ${ref[2]}`) : null;
    if (obj) {
      const data = decode(obj.dict, obj.stream);
      if (data) map = parseToUnicode(data.toString("latin1"));
    }
  }

  let widths = new Map<number, number>();
  let defaultWidth = isCID ? 1000 : 500;
  if (isCID) {
    // 폭은 글꼴 자신이 아니라 /DescendantFonts 가 들고 있다.
    const descRaw = dictValue(fontDict, "DescendantFonts");
    const ref = descRaw ? /(\d+)\s+(\d+)\s*R/.exec(descRaw) : null;
    const desc = ref ? objects.get(`${ref[1]} ${ref[2]}`)?.dict : null;
    if (desc) {
      const w = dictValue(desc, "W");
      if (w) widths = parseW(w);
      const dw = dictValue(desc, "DW");
      if (dw && Number.isFinite(Number(dw))) defaultWidth = Number(dw);
    }
  } else {
    const first = Number(dictValue(fontDict, "FirstChar") ?? NaN);
    const raw = dictValue(fontDict, "Widths");
    const list = raw
      ? (/^\s*(\d+)\s+(\d+)\s*R/.test(raw) ? resolve(objects, raw) : raw)
      : null;
    if (list && Number.isFinite(first)) {
      const nums = list.replace(/[[\]]/g, " ").trim().split(/\s+/).filter(Boolean).map(Number);
      nums.forEach((w, k) => widths.set(first + k, w));
    }
    const mw = Number(dictValue(fontDict, "MissingWidth") ?? NaN);
    if (Number.isFinite(mw)) defaultWidth = mw;
  }

  return { map, width: isCID ? 2 : 1, widths, defaultWidth };
}

/* ------------------------------------------------------------ 본문 스트림 읽기 */

function readLiteral(s: string, i: number): [number[], number] {
  let depth = 1;
  const bytes: number[] = [];
  while (i < s.length && depth > 0) {
    const ch = s[i];
    if (ch === "\\") {
      const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4));
      if (oct) { bytes.push(parseInt(oct[0], 8) & 0xff); i += 1 + oct[0].length; continue; }
      const n = s[i + 1];
      const esc = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 }[n];
      if (esc !== undefined) bytes.push(esc);
      else if (n !== "\n" && n !== "\r") bytes.push(n.charCodeAt(0) & 0xff);
      i += 2;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) { i++; break; } }
    bytes.push(ch.charCodeAt(0) & 0xff);
    i++;
  }
  return [bytes, i];
}

function bytesToText(bytes: number[], font: PdfFont | null): string {
  // 제어 바이트가 많이 섞여 있으면 우리가 읽을 수 있는 글이 아니다. 대개
  // 2바이트 코드를 1바이트로 읽고 있다는 표시이고, 그대로 내보내면
  // "Í\x00Í\x10Í Í0Í@" 같은 줄이 본문에 섞여 청크를 통째로 버린다.
  // 0x80~0x9f 도 제어 영역이다(C1). 이걸 빼먹으면 "Í\x80" 같은 짝이 그대로 남는다.
  const isControl = (b: number) => b < 0x20 || b === 0x7f || (b >= 0x80 && b <= 0x9f);
  const control = bytes.reduce((n, b) => n + (isControl(b) ? 1 : 0), 0);
  // `Tj` 가 글자 하나(2바이트)씩 그리는 PDF 가 흔하므로 기준은 2바이트부터다.
  const garbled = bytes.length >= 2 && control / bytes.length > 0.2;

  if (!font) return garbled ? "" : Buffer.from(bytes).toString("latin1").replace(/[\x00-\x1f\x7f\x80-\x9f]/g, "");

  if (font.width === 2) {
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      out += font.map.get(code) ?? "";
    }
    return out;
  }

  if (garbled) return "";
  let out = "";
  for (const b of bytes) {
    const mapped = font.map.get(b);
    // 표에 없으면 바이트를 그대로 쓴다. 표준 인코딩 폰트는 이 경로로 읽힌다.
    // 다만 제어 바이트는 어느 인코딩에서도 글자가 아니므로 버린다.
    if (mapped !== undefined) out += mapped;
    else if (!isControl(b)) out += String.fromCharCode(b);
  }
  return out;
}

/**
 * 본문 스트림에서 글자를 뽑는다.
 *
 * 위치 연산자(`Td` `TD` `T*` `Tm`)를 줄바꿈으로 삼는다. PDF 에는 '줄' 이라는
 * 개념이 없고 글자마다 좌표만 있으므로, 다음 줄로 내려간 사실을 이것 말고는
 * 알 길이 없다. `TJ` 배열의 큰 음수는 자간 벌림인데, 임계값을 넘으면 낱말
 * 사이로 본다 — 없으면 한 줄이 통째로 붙어 나온다.
 *
 * 가로 이동을 띄어쓰기로 보는 판단에는 **글자 폭**이 필요하다. 그게 없으면
 * 글자마다 좌표를 찍는 PDF 에서 모든 글자 사이가 띄어쓰기가 된다. 실제로
 * 이 매뉴얼은 이렇게 생겼다.
 *
 *     /F4 34.666668 Tf
 *     0 -27.658855 Td <0036> Tj      ← 'S'
 *     21.01712 0    Td <0048> Tj      ← 'e'  (21.017 은 'S' 의 폭이다)
 *     19.155701 0   Td <0044> Tj      ← 'a'
 *
 * 글자는 붙어 있고, 진짜 띄어쓰기는 <0003>(공백 글리프)으로 따로 찍혀 있다.
 * 그런데 "가로로 조금이라도 움직이면 띄어쓰기" 라는 규칙은 매 글자마다
 * 참이어서 "S e a r c h" 를 만들어 냈다.
 *
 * 그래서 글자를 그린 뒤 **펜이 가 있어야 할 자리**를 추정해 두고, 다음 좌표가
 * 그보다 더 벌어졌을 때에만 띄어쓰기로 본다. 폭은 글꼴 표(/Widths, /W)를
 * 읽으면 정확하지만, 글자 크기와 문자 종류만으로도 충분히 가른다 — 한글·한자는
 * 한 칸(em), 라틴 문자는 대략 반 칸이다. 우리가 가려야 하는 것은 '0 에 가까운
 * 틈' 과 '한 칸짜리 틈' 이라, 추정이 조금 빗나가도 판단은 바뀌지 않는다.
 */

/** 전각으로 칠 글자인가. 한글·한중일 한자·가나·전각 기호. */
function isWide(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6)
  );
}

/**
 * 라틴 글자의 대략적인 폭(em). 반 칸으로 뭉뚱그리면 m·W 뒤에서 펜이 뒤처져
 * "Form ula" 처럼 없는 띄어쓰기가 생긴다. 정확한 값은 글꼴 표에 있지만,
 * 우리가 가려야 하는 것은 '0 에 가까운 틈' 과 '한 칸짜리 틈' 뿐이라 이 정도로
 * 충분하다.
 */
const NARROW = "iljtfIr.,;:'`|!()[]{}-";
const WIDE_LATIN = "mwMW@%";

/**
 * 이 글자 코드들을 이 크기로 그리면 펜이 얼마나 나아가는가.
 *
 * 글꼴 표가 있으면 계산이고, 없으면 {@link advanceOf} 의 어림이다. 표가 있는
 * 쪽이 훨씬 정확해서, 어림으로는 남던 "SF- 1" 류의 없는 띄어쓰기가 사라진다.
 */
function advanceOfBytes(bytes: number[], font: PdfFont | null, text: string, size: number): number {
  if (!font || font.widths.size === 0) return advanceOf(text, size);
  const step = font.width;
  let em = 0;
  for (let i = 0; i + step - 1 < bytes.length; i += step) {
    const code = step === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
    const w = font.widths.get(code);
    if (w !== undefined) {
      em += w / 1000;
      continue;
    }
    // 표에 없는 코드. 규격은 /DW 로 가라 하지만 그 값은 보통 1000(한 칸)이고,
    // 공백이나 하이픈에 한 칸을 주면 펜이 크게 앞질러 그 뒤의 띄어쓰기를
    // 통째로 삼킨다. 글자를 아는 경우에는 글자 종류로 어림하는 편이 낫다.
    const ch = font.map.get(code);
    em += ch ? advanceOf(ch, 1) : font.defaultWidth / 1000;
  }
  return em * size;
}

/** 이 글자들을 이 크기로 그리면 펜이 얼마나 나아가는가(어림). */
function advanceOf(text: string, size: number): number {
  let em = 0;
  for (const ch of text) {
    if (isWide(ch)) em += 1;
    else if (NARROW.includes(ch)) em += 0.3;
    else if (WIDE_LATIN.includes(ch)) em += 0.85;
    else em += 0.56;
  }
  return em * size;
}
function extractText(content: Buffer, fonts: Map<string, PdfFont>): string {
  const s = content.toString("latin1");
  let out = "";
  let font: PdfFont | null = null;
  let pendingFontName: string | null = null;
  let i = 0;
  // 글자가 놓인 자리. PDF 에는 '줄' 이 없고 좌표만 있으므로, 줄이 바뀐
  // 사실은 Y 가 움직였다는 것으로만 알 수 있다. 이걸 안 보고 위치 연산자를
  // 전부 줄바꿈으로 삼으면 낱말마다 줄이 바뀐다 — 한국어 PDF 는 낱말을
  // 하나씩 놓는 일이 흔해서, 그 상태로는 문단이라는 것이 없어진다.
  let y: number | null = null;
  /** 마지막으로 그린 글자 다음에 펜이 서 있을 자리. 띄어쓰기 판단의 기준이다. */
  let penX: number | null = null;
  /** 현재 글자 크기. `Tf` 가 알려 준다. 모르면 흔한 본문 크기로 둔다. */
  let size = 10;
  // 줄이 바뀌었다고 볼 세로 이동. 글자 크기보다 작으면 같은 줄의 미세 조정이다.
  const LINE_EPS = 2.5;
  /**
   * 펜이 있어야 할 자리보다 이만큼(글자 크기의 1/4) 넘게 앞서 있으면 빈칸을
   * 건너뛴 것으로 본다. 글꼴 표를 읽고 나서는 0.15~0.40 어디를 넣어도 결과가
   * 같았다 — 값이 결과를 좌우하지 않는다는 건 모델이 맞다는 뜻이고, 그래서
   * 한 칸의 4분의 1이라는 설명하기 쉬운 값으로 둔다.
   */
  const SPACE_RATIO = 0.25;

  /**
   * 다음에 글자를 놓을 자리(텍스트 줄 행렬). `Tm` 이 절대값으로 정하고
   * `Td`·`T*` 가 거기서 상대로 움직인다. **그리기 전까지는 판단하지 않는다** —
   * 이게 이 파일에서 가장 중요한 한 줄이다.
   *
   * 낱말마다 `BT /F4 .. Tf  1 0 0 -1 0 15.16 Tm  108.9 -27.6 Td <..> Tj ET` 를
   * 여는 생성기가 흔한데, `Tm` 을 보자마자 "세로로 움직였다" 고 하면 매 낱말이
   * 줄을 바꾼다. 실제 자리는 뒤따르는 `Td` 까지 더해야 나오므로, 글자를 실제로
   * 그리는 순간에 한 번만 견주면 된다.
   */
  let tx = 0;
  let ty = 0;

  /** 그리기 직전에 자리를 견준다. 세로로 움직였으면 줄바꿈, 펜보다 앞서 있으면 띄어쓰기. */
  const settle = (): void => {
    if (y !== null && Math.abs(ty - y) > Math.max(LINE_EPS, size * 0.3)) {
      if (out && !out.endsWith("\n")) out += "\n";
    } else if (penX !== null && tx - penX > size * SPACE_RATIO && out && !/\s$/.test(out)) {
      // 펜이 있어야 할 자리보다 4분의 1 칸 넘게 앞이면 빈칸을 건너뛴 것이다.
      out += " ";
    }
    penX = tx;
    y = ty;
  };

  /** 글자를 덧붙이면서 펜을 그만큼 민다. */
  const draw = (bytes: number[]): void => {
    const text = bytesToText(bytes, font);
    const adv = advanceOfBytes(bytes, font, text, size);
    if (!text) {
      // 글꼴 표에 없는 글리프. 내놓을 글자는 없어도 자리는 차지했다 — 펜을
      // 밀어 두지 않으면 다음 글자가 멀리 있는 것처럼 보여 없는 띄어쓰기가 생긴다.
      y = ty;
      penX = tx + adv;
      return;
    }
    settle();
    out += text;
    if (penX !== null) penX += adv;
  };
  const numbersBefore = (at: number, count: number): number[] | null => {
    const before = s.slice(Math.max(0, at - 140), at);
    const nums = before.match(/-?\d*\.?\d+/g);
    return nums && nums.length >= count ? nums.slice(-count).map(Number) : null;
  };

  while (i < s.length) {
    const ch = s[i];

    if (ch === "/") {
      const m = /^\/([^\s/<>[\]()]+)/.exec(s.slice(i));
      if (m) { pendingFontName = m[1]; i += m[0].length; continue; }
    }
    if (ch === "(") {
      const [bytes, next] = readLiteral(s, i + 1);
      draw(bytes);
      i = next;
      continue;
    }
    if (ch === "<" && s[i + 1] !== "<") {
      const end = s.indexOf(">", i);
      if (end < 0) break;
      const hex = s.slice(i + 1, end).replace(/[^0-9A-Fa-f]/g, "");
      const bytes: number[] = [];
      for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2).padEnd(2, "0"), 16));
      draw(bytes);
      i = end + 1;
      continue;
    }
    const op = /^(Tf|TJ|Tj|TD|Td|T\*|TL|Tm|BT|ET|'|")/.exec(s.slice(i));
    if (op) {
      const name = op[1];
      if (name === "Tf") {
        font = pendingFontName ? fonts.get(pendingFontName) ?? null : null;
        // `/F4 34.666668 Tf` — 이름 다음의 수가 크기다.
        const n = numbersBefore(i, 1);
        if (n && n[0] > 0 && n[0] < 400) size = n[0];
      } else if (name === "Tm") {
        // a b c d e f Tm — e, f 가 절대 좌표다. 줄 행렬을 통째로 다시 세운다.
        const n = numbersBefore(i, 6);
        if (n) { tx = n[4]; ty = n[5]; }
      } else if (name === "Td" || name === "TD") {
        // tx ty Td — 줄 행렬 기준의 상대 이동이다.
        const n = numbersBefore(i, 2);
        if (n) { tx += n[0]; ty += n[1]; }
      } else if (name === "T*" || name === "'" || name === '"') {
        // 다음 줄로. 행간을 따로 추적하지 않으므로 글자 크기만큼 내린다 —
        // settle() 이 세로 이동만 보면 되니 값의 정확도는 중요하지 않다.
        tx = 0;
        ty -= size;
      }
      // BT 에서 좌표를 지우지 않고 ET 에서 줄을 바꾸지도 않는다.
      // 낱말마다 BT…ET 를 여는 생성기가 흔한데(한컴·워드), 그때 초기화하면
      // Y 를 비교할 상대가 없어지고 ET 가 줄을 끊어 낱말마다 한 줄이 된다.
      // 줄이 바뀌었다는 판단은 오직 Y 가 움직였는지로만 한다.
      i += name.length;
      continue;
    }
    const gap = /^(-\d{3,})/.exec(s.slice(i));
    if (gap) {
      if (out && !/\s$/.test(out)) out += " ";
      i += gap[1].length;
      continue;
    }
    i++;
  }
  return out;
}

/* ---------------------------------------------------------------------- 입구 */

/** `/Contents` 는 스트림 하나일 수도, 스트림들의 배열일 수도 있다. */
function contentsOf(objects: Map<string, PdfObject>, pageDict: string): Buffer[] {
  const raw = dictValue(pageDict, "Contents");
  if (!raw) return [];
  const refs = [...raw.matchAll(/(\d+)\s+(\d+)\s*R/g)].map((m) => `${m[1]} ${m[2]}`);
  const out: Buffer[] = [];
  for (const key of refs) {
    const obj = objects.get(key);
    if (!obj) continue;
    const data = decode(obj.dict, obj.stream);
    if (data) out.push(data);
  }
  return out;
}

/** 페이지의 `/Resources /Font` 에서 이름→폰트 표를 만든다. 상속된 자원도 따라간다. */
function fontsOf(objects: Map<string, PdfObject>, pageDict: string, inherited: string | null): Map<string, PdfFont> {
  const resRaw = dictValue(pageDict, "Resources");
  const res = resRaw ? (/^\s*\d+\s+\d+\s*R/.test(resRaw) ? resolve(objects, resRaw) : resRaw) : inherited;
  if (!res) return new Map<string, PdfFont>();
  const fontRaw = dictValue(res, "Font");
  if (!fontRaw) return new Map<string, PdfFont>();
  const fontDict = /^\s*\d+\s+\d+\s*R/.test(fontRaw) ? resolve(objects, fontRaw) : fontRaw;
  const fonts = new Map<string, PdfFont>();
  for (const m of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+(\d+)\s*R/g)) {
    const obj = objects.get(`${m[2]} ${m[3]}`);
    if (obj) fonts.set(m[1], readFont(objects, obj.dict));
  }
  return fonts;
}

export function pdfToText(buf: Buffer): string {
  const objects = expandObjectStreams(scanObjects(buf));

  // 페이지를 찾아 순서대로 읽는다. 페이지를 못 찾으면(드물다) 본문처럼 보이는
  // 스트림을 전부 훑는 쪽으로 내려간다 — 순서는 잃지만 글자는 건진다.
  const pages = [...objects.entries()].filter(([, o]) => /\/Type\s*\/Page\b/.test(o.dict));
  const chunks: string[] = [];

  if (pages.length > 0) {
    const rootRes = [...objects.values()].find((o) => /\/Type\s*\/Pages\b/.test(o.dict));
    const inherited = rootRes ? dictValue(rootRes.dict, "Resources") : null;
    for (const [, page] of pages) {
      const fonts = fontsOf(objects, page.dict, inherited);
      for (const content of contentsOf(objects, page.dict)) {
        const t = extractText(content, fonts);
        if (t.trim()) chunks.push(t);
      }
    }
  }

  if (chunks.join("").trim().length === 0) {
    // 내려가는 길. 모든 폰트를 한 표에 모아 쓰는데, 이름이 겹치면 마지막
    // 것이 이긴다 — 정확하진 않아도 아무것도 못 얻는 것보다 낫다.
    const fonts = new Map<string, PdfFont>();
    for (const [, obj] of objects) {
      if (!/\/Type\s*\/Font\b/.test(obj.dict)) continue;
      const name = /\/BaseFont\s*\/([^\s/<>[\]()]+)/.exec(obj.dict)?.[1];
      if (name) fonts.set(name, readFont(objects, obj.dict));
    }
    for (const [, obj] of objects) {
      if (!obj.stream) continue;
      if (/\/Type\s*\/(ObjStm|XObject|Metadata|XRef|Font|FontDescriptor)/.test(obj.dict)) continue;
      const data = decode(obj.dict, obj.stream);
      if (!data) continue;
      if (!/\bBT\b/.test(data.subarray(0, 8192).toString("latin1"))) continue;
      const t = extractText(data, fonts);
      if (t.trim()) chunks.push(t);
    }
  }

  return chunks
    .join("\n\n")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
