/**
 * 올라온 파일에서 **본문만** 남긴다. 청킹 바로 앞에 선다.
 *
 * 왜 필요한가: 5.4MB 매뉴얼을 올려 청크를 열어 보면 본문이 아닌 것이 그대로
 * 섞여 있었다 — 쪽마다 한 줄씩 들어앉은 쪽번호 414개, 글꼴을 잘못 읽어 생긴
 * "Í Í0Í@ÍPÍ`Íp" 같은 줄, 줄 앞에 남은 들여쓰기 공백. 사람이 읽을 때는 눈이
 * 걸러 주지만, 청크로 잘려 임베딩되면 **그 청크 하나를 통째로 버리게 만든다**.
 * 검색에 걸리지도 않고, 걸려도 답에 쓸 수 없다.
 *
 * 무엇을 하지 않는가: 문장을 고쳐 쓰지 않는다. 요약하지도, 번역하지도, 순서를
 * 바꾸지도 않는다. 하는 일은 **글자가 아닌 것을 덜어내는 것** 뿐이고, 본문
 * 글자는 하나도 건드리지 않는다 — 검사가 그걸 지킨다.
 *
 * 어디에 쓰나: PDF·마크다운·텍스트 어느 쪽에서 왔든 통과한다. 다만 쪽번호
 * 제거처럼 '쪽이 있는 문서' 에서만 뜻이 통하는 규칙은
 * {@link PreprocessOptions.paged} 가 켜져 있을 때만 돈다. 마크다운에서 숫자만
 * 있는 줄을 쪽번호로 착각해 지우면, 고치려던 것보다 큰 것을 잃는다.
 */

export interface PreprocessOptions {
  /** 쪽이 있는 문서(PDF)에서 뽑은 글인가. 쪽번호 제거는 이때만 한다. */
  paged?: boolean;
}

export interface PreprocessReport {
  /** 지운 쪽번호 줄 수. */
  pageNumbers: number;
  /** 지운 깨진 줄 수(글꼴을 잘못 읽어 생긴 것). */
  garbled: number;
  /** 줄 끝에서 잘린 영어 낱말을 도로 붙인 횟수. */
  rejoined: number;
  charsBefore: number;
  charsAfter: number;
}

export interface PreprocessResult {
  text: string;
  report: PreprocessReport;
}

/**
 * 글자가 아닌 것들. 제어문자(Cc)와 서식문자(Cf — 폭 없는 공백, 방향 지정,
 * BOM)는 화면에 아무것도 그리지 않으면서 검색어와의 일치만 망가뜨린다.
 * 개행과 탭은 구조라서 남긴다.
 */
const INVISIBLE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g;

/** 공백처럼 보이지만 보통 공백이 아닌 것들. NBSP·전각 공백 따위. */
const ODD_SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

/** 쪽번호만 덩그러니 있는 줄. 로마숫자 쪽번호(ii, iv)와 `- 12 -` 꼴도 흔하다. */
const PAGE_NUMBER = /^(?:\d{1,4}|[ivxlcdm]{1,7}|-\s*\d{1,4}\s*-)$/i;

/**
 * 라틴-1 보충 영역. 2바이트 글자 코드를 1바이트로 읽으면 이 영역의 글자가
 * 줄줄이 나온다("Í Í0Í@"). 한국어에도 영어에도 이 영역은 거의 안 쓰여서,
 * 한 줄에서 비중이 높다는 것 자체가 잘못 읽었다는 표시가 된다. 저작권 기호
 * 하나쯤 섞인 정상 문장은 비중이 낮아 걸리지 않는다.
 */
const MOJIBAKE = /[À-ÿ]/g;
const MOJIBAKE_RATIO = 0.3;
const MOJIBAKE_MIN_CHARS = 8;

function isGarbled(line: string): boolean {
  if (line.length < MOJIBAKE_MIN_CHARS) return false;
  const hits = line.match(MOJIBAKE)?.length ?? 0;
  return hits / line.length >= MOJIBAKE_RATIO;
}

/**
 * 본문만 남긴다. 통과한 글자는 원문 그대로다 — 무엇을 덜어냈는지는 report 가 말한다.
 */
export function preprocess(text: string, opts: PreprocessOptions = {}): PreprocessResult {
  const source = String(text ?? "");
  const report: PreprocessReport = {
    pageNumbers: 0,
    garbled: 0,
    rejoined: 0,
    charsBefore: source.length,
    charsAfter: 0,
  };

  // 1. 글자 모양을 하나로 맞춘다. 자모가 풀린 한글이 섞여 들어오면 검색어와
  //    영영 만나지 못하므로 NFC 로 모은다.
  let body = source.normalize("NFC").replace(/\r\n?/g, "\n").replace(ODD_SPACE, " ").replace(INVISIBLE, "");

  // 2. 줄 단위로 덜어낸다.
  const kept: string[] = [];
  for (const raw of body.split("\n")) {
    // 줄 안의 연속 공백은 하나로. 표를 옮기다 생긴 열 맞춤 공백이 대부분이다.
    const line = raw.replace(/[ \t]+/g, " ").trim();
    if (!line) {
      kept.push("");
      continue;
    }
    if (isGarbled(line)) {
      report.garbled++;
      continue;
    }
    if (opts.paged && PAGE_NUMBER.test(line)) {
      report.pageNumbers++;
      continue;
    }
    kept.push(line);
  }
  body = kept.join("\n");

  // 3. 줄 끝에서 잘린 영어 낱말을 도로 붙인다("config-\nuration" → "configuration").
  //    한국어에는 이 관습이 없으므로 영문자 사이에서만 한다.
  body = body.replace(/([A-Za-z])-\n([a-z])/g, (_m, a: string, b: string) => {
    report.rejoined++;
    return a + b;
  });

  // 4. 빈 줄은 문단의 경계로만 남긴다. 셋 이상 이어지면 하나로 줄인다.
  body = body.replace(/\n{3,}/g, "\n\n").trim();

  report.charsAfter = body.length;
  return { text: body, report };
}

/** 로그 한 줄로 요약한다. 아무것도 덜어내지 않았으면 빈 문자열이다. */
export function describeReport(report: PreprocessReport): string {
  const parts: string[] = [];
  if (report.pageNumbers) parts.push(`쪽번호 ${report.pageNumbers}줄`);
  if (report.garbled) parts.push(`깨진 줄 ${report.garbled}`);
  if (report.rejoined) parts.push(`분철 복구 ${report.rejoined}`);
  const trimmed = report.charsBefore - report.charsAfter;
  if (trimmed > 0) parts.push(`${trimmed.toLocaleString("ko-KR")}자 정리`);
  return parts.join(", ");
}
