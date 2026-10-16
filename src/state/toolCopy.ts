import type { ToolDefinition } from "../api/types";

// 도구 설정 화면에 보이는 한국어 글. 서버의 도구 설명(영어)은 모델에게 가는 것이라
// 그대로 두고, 사람이 읽는 글은 여기서 따로 쓴다.

/**
 * Korean copy for each built-in tool: a one-line summary for the card face,
 * and a fuller explanation (what it's for, when to reach for it, how it
 * differs from a neighbouring tool) for the expanded detail. Keyed by tool
 * name; a tool not listed here still renders using the API's English
 * `description` for both fields so nothing ever shows blank.
 */
export const TOOL_COPY: Record<string, { short: string; long: string }> = {
  calculator: {
    short: "사칙연산과 수학 함수를 계산합니다.",
    long: "괄호와 +, -, *, /, %, ^(거듭제곱)를 지원하며 sin·cos·tan·sqrt·log 등 일반적인 Math 함수와 원주율(pi), 자연상수(e)를 사용할 수 있습니다. 복잡한 수식을 암산하지 않고 정확한 값이 필요할 때 사용하세요. 임의의 코드를 실행하지는 않아 안전합니다.",
  },
  get_current_time: {
    short: "현재 날짜와 시각을 조회합니다.",
    long: "타임존(예: Asia/Seoul, America/New_York)을 지정하면 해당 지역의 현재 시각을 사람이 읽기 쉬운 형태와 UTC ISO 8601 타임스탬프로 함께 반환합니다. 생략하면 UTC 기준입니다. \"지금 몇 시야\" 같은 질문에 사용하고, 시간대 변환이나 날짜 계산이 필요하면 datetime_calc를 대신 쓰세요.",
  },
  unit_convert: {
    short: "길이·무게·부피 등 단위를 변환합니다.",
    long: "길이, 무게, 부피, 속도, 면적, 디지털 저장 용량, 온도(섭씨/화씨/켈빈) 단위를 서로 변환합니다. from과 to는 같은 종류의 단위여야 하며 종류는 자동으로 인식됩니다. 통화 변환에는 사용할 수 없으니 환율은 currency_convert를 사용하세요.",
  },
  datetime_calc: {
    short: "시간대 변환과 날짜·시간 가감을 계산합니다.",
    long: "특정 일시를 다른 시간대로 환산하거나 일/시/분/초 단위로 더하고 뺄 수 있습니다. \"지금부터 30일 후는 며칠인지\", \"한국 시간 오후 3시는 뉴욕 기준 몇 시인지\" 같은 계산에 사용하세요. 단순히 지금 시각만 필요하면 get_current_time이 더 간단합니다.",
  },
  text_stats: {
    short: "글자 수·단어 수 등 텍스트 통계를 계산합니다.",
    long: "문자 수, 단어 수, 문장·문단 수, 예상 읽기 시간, 가장 많이 등장한 단어를 정확히 계산합니다. 글자 수 제한 확인이나 \"이 글이 몇 단어인지\" 같은 질문에 모델이 직접 세는 것보다 정확하고 즉각적입니다.",
  },
  data_convert: {
    short: "JSON과 CSV 형식을 서로 변환합니다.",
    long: "문자열로 된 데이터를 JSON에서 CSV로, 혹은 CSV에서 JSON으로 바꾸거나 JSON을 보기 좋게 정렬(pretty-print)하거나 압축(minify)합니다. JSON→CSV는 평평한 객체의 배열이어야 하며, CSV→JSON은 첫 번째 행을 열 이름으로 사용합니다.",
  },
  encode_decode: {
    short: "Base64·URL 인코딩과 JWT 디코딩을 처리합니다.",
    long: "텍스트를 base64, base64url, hex, URL 컴포넌트 형식으로 인코딩하거나 디코딩합니다. JWT 토큰의 헤더와 페이로드를 디코딩할 수도 있지만 서명 검증은 하지 않습니다. 형식이 잘못된 입력은 깨진 값을 주는 대신 명확한 오류로 알려줍니다. 네트워크 없이 로컬에서 즉시 처리됩니다.",
  },
  hash_text: {
    short: "텍스트의 해시값(체크섬)을 계산합니다.",
    long: "md5, sha1, sha256, sha512 알고리즘으로 텍스트의 해시 다이제스트를 16진수로 계산합니다. 체크섬 확인이나 \"SHA256 값이 뭐야\" 같은 요청에 사용하세요. 솔트나 키 유도 함수가 없어 비밀번호 저장 용도로는 적합하지 않으며, md5·sha1은 레거시 호환 목적으로만 제공됩니다.",
  },
  generate_random: {
    short: "UUID나 랜덤 토큰을 생성합니다.",
    long: "암호학적으로 안전한 난수로 v4 UUID 또는 지정한 바이트 길이의 hex·base64 토큰을 생성합니다. 세션 토큰이나 임시 ID가 필요할 때 사용하고, 특정하거나 재현 가능한 값이 필요한 경우에는 적합하지 않습니다.",
  },
  color_convert: {
    short: "색상 코드를 hex·rgb·hsl 간에 변환합니다.",
    long: "hex(#3498db), rgb(rgb(52,152,219)), hsl(hsl(204,70%,53%)) 중 어떤 형식으로 입력해도 나머지 두 표기법을 함께 반환합니다. 디자인 작업에서 색상 표기 형식을 맞출 때 사용하세요.",
  },
  diff_text: {
    short: "두 텍스트의 줄 단위 차이를 비교합니다.",
    long: "두 버전의 텍스트를 줄 단위로 비교해 추가·삭제·변경 없는 부분을 표시합니다. 변경 없는 구간이 길면 개수로 축약하고 앞뒤 몇 줄만 문맥으로 보여줍니다. 두 문서나 코드가 정확히 무엇이 달라졌는지 눈으로 비교하는 대신 사용하세요.",
  },
  web_search: {
    short: "웹을 검색해 관련 결과와 요약을 찾습니다.",
    long: "공개 웹을 검색해 제목·URL·발췌문이 포함된 순위별 결과와, 가능한 경우 짧은 종합 답변을 반환합니다. 아직 구체적인 URL이 없고 최신 정보나 출처를 찾아야 할 때 사용하세요. 특정 결과의 본문을 전체로 읽으려면 그 URL로 http_fetch를 이어서 호출하면 됩니다. 최신 이슈이거나 여러 출처를 비교해야 할 때는 wikipedia_lookup보다 이 도구가 낫습니다.",
  },
  http_fetch: {
    short: "URL을 요청해 원문 텍스트를 가져옵니다.",
    long: "지정한 URL에 GET 요청을 보내 상태 코드와 텍스트로 변환된 본문(HTML 태그 제거)을 반환합니다. 로컬호스트나 사설 네트워크 주소로는 접근할 수 없습니다. 기사 본문처럼 정제된 결과가 필요하면 article_extract가 더 적합하고, 비HTML 응답이나 정확한 원본 마크업이 필요할 때만 이 도구를 사용하세요.",
  },
  article_extract: {
    short: "웹 페이지에서 기사 본문만 추출합니다.",
    long: "링크에서 내비게이션, 광고, 상용구를 제거하고 실제 기사 제목과 본문만 뽑아냅니다. 사용자가 링크를 주고 내용 요약이나 정리를 원할 때는 http_fetch보다 이 도구를 우선 사용하세요. 원본 그대로의 마크업이나 HTML이 아닌 응답이 필요할 때만 http_fetch를 사용합니다. web_search와 달리 이미 알고 있는 URL 하나를 깊이 읽을 때 씁니다.",
  },
  weather_lookup: {
    short: "특정 지역의 현재 날씨를 조회합니다.",
    long: "도시나 지명을 입력하면 지오코딩 후 기온, 체감온도, 습도, 풍속, 날씨 상태를 구조화된 데이터로 반환합니다(Open-Meteo, API 키 불필요). 날씨를 물을 때는 산문 형태의 결과만 주는 web_search보다 빠르고 정확하므로 이 도구를 우선 사용하세요.",
  },
  wikipedia_lookup: {
    short: "위키백과에서 주제를 검색해 요약을 가져옵니다.",
    long: "영어 위키백과에서 인물, 장소, 개념, 사건 등 백과사전적 사실을 검색해 짧은 요약과 정식 표제어, 문서 URL을 반환합니다. web_search처럼 여러 결과를 순위대로 주는 대신 신뢰할 수 있는 요약 하나만 제공합니다. 최신 이슈이거나 여러 출처를 비교해야 한다면 web_search가 더 적합합니다.",
  },
  currency_convert: {
    short: "환율에 따라 통화 금액을 변환합니다.",
    long: "유럽중앙은행(ECB)의 일일 기준 환율(frankfurter.dev, API 키 불필요)로 금액을 다른 통화로 변환합니다. USD, EUR, KRW, JPY, GBP 같은 ISO 4217 코드를 사용하세요. 환율은 평일 하루 한 번만 갱신되는 참고용 값이라 실시간 시장 환율이 아니니, 사용자가 실시간 환율을 원한다면 그렇게 안내해야 합니다.",
  },
  read_text_file: {
    short: "서버에 허용된 폴더 안의 텍스트 파일을 읽습니다.",
    long: "서버에 설정된 파일시스템 루트 하위의 UTF-8 텍스트 파일만 읽을 수 있습니다. 경로는 심볼릭 링크를 따라간 뒤에도 루트 안에 있는지 검사하며, 바이너리 파일은 거부됩니다. 어떤 파일이 있는지 먼저 보려면 list_directory를 사용하세요.",
  },
  list_directory: {
    short: "서버에 허용된 폴더의 파일 목록을 봅니다.",
    long: "서버에 설정된 파일시스템 루트 하위 디렉터리의 항목을 나열합니다. 경로를 생략하면 루트 자체를 보여줍니다. 특정 파일의 내용을 읽으려면 이어서 read_text_file을 사용하세요.",
  },
  regex_test: {
    short: "정규식이 텍스트에 어떻게 매칭되는지 확인합니다.",
    long: "정규식을 텍스트에 적용해 매칭된 문자열과 위치, 번호 그룹과 이름 있는 그룹을 보여줍니다. 패턴은 앞뒤 슬래시 없이 본문만 넣고, 플래그는 gimsuy 중에서 고릅니다. 역추적이 폭발해 서버를 멈출 수 있는 패턴은 실행하지 않고 미리 거부합니다.",
  },
  json_query: {
    short: "JSON에서 경로로 값을 뽑아냅니다.",
    long: "점으로 구분한 경로로 JSON 문서에서 값을 추출합니다. 키, 배열 인덱스 [0], 배열 전체 [*], 객체의 모든 값 * 를 조합할 수 있습니다. 예를 들어 items[*].name 은 배열 각 항목의 name 을 모두 가져옵니다. 값마다 실제 경로를 함께 돌려주므로 어디서 나온 값인지 확인할 수 있습니다.",
  },
  sort_unique: {
    short: "줄 단위로 정렬·중복 제거·개수 집계를 합니다.",
    long: "여러 줄로 된 텍스트를 셸의 sort·uniq 처럼 처리합니다. sort 는 중복을 남긴 채 정렬하고, unique 는 중복을 제거한 뒤 정렬하며, count 는 줄마다 몇 번 나왔는지 많은 순으로 보여줍니다. 오름차순·내림차순, 숫자 비교, 대소문자 무시, 앞뒤 공백 제거를 선택할 수 있습니다.",
  },
  unicode_inspect: {
    short: "문자 단위로 코드포인트와 정규화를 확인합니다.",
    long: "글자마다 코드포인트(U+XXXX), UTF-8 바이트 수, 제어문자·폭 없는 문자 여부를 보여주고, NFC·NFD·NFKC·NFKD 네 가지 정규화 형태 중 어느 것이 원본과 다른지 알려줍니다. 한글이 완성형 음절인지 분해된 자모인지도 구분합니다. 눈으로는 똑같은데 비교하면 다르다고 나올 때 쓰세요.",
  },
  cidr_calc: {
    short: "CIDR 대역의 네트워크 정보를 계산합니다.",
    long: "10.0.0.0/22 같은 IPv4 대역에서 네트워크·브로드캐스트 주소, 넷마스크, 와일드카드 마스크, 사용 가능한 첫 호스트와 마지막 호스트, 전체 주소 수와 호스트 수를 계산합니다. 사설·루프백·링크로컬 여부도 알려주고, 특정 IP가 그 대역에 속하는지 확인할 수 있습니다. /31과 /32는 실제 의미대로 처리합니다.",
  },
  cron_describe: {
    short: "크론 표현식의 뜻과 다음 실행 시각을 알려줍니다.",
    long: "분·시·일·월·요일 다섯 자리 크론 표현식을 사람이 읽는 문장으로 풀어주고, 지정한 시간대 기준으로 다음 실행 시각들을 보여줍니다. *, 목록(1,2,3), 범위(1-5), 간격(*/15), 영문 월·요일 약자를 지원합니다. 2월 30일처럼 영원히 오지 않는 조건이면 그렇다고 알려줍니다.",
  },
  url_parse: {
    short: "URL을 구성 요소로 분해합니다.",
    long: "URL을 스킴, 호스트, 포트, 경로와 각 구간, 쿼리 파라미터, 프래그먼트로 나눠 보여줍니다. 쿼리는 퍼센트 디코딩해 이름과 값의 쌍으로 주고 같은 키가 여러 번 나와도 순서대로 유지합니다. 호스트가 IP인지 도메인인지, 퓨니코드라면 원래 유니코드 형태가 무엇인지도 알려줍니다. 비밀번호는 있는지 여부만 알리고 값은 보여주지 않습니다.",
  },
  schedule_task: {
    short: "정해 둔 시각에 작업을 자동으로 실행합니다.",
    long: "\"11시에 장바구니에 담아줘\", \"30분 뒤에 확인해줘\"처럼 시각이 들어간 요청을 그때 실행되도록 예약합니다. 시각은 한국 시간 기준이며, 예약한 시각이 되면 같은 대화에 그 요청이 새 질문으로 들어가 그때 쓸 수 있는 도구로 처리됩니다. 크롬 제어가 켜진 대화에서는 사용자의 크롬에서 실행됩니다. 지금 바로 실행하지는 않고 예약만 해 둡니다.",
  },
  list_scheduled_tasks: {
    short: "예약해 둔 작업과 최근 결과를 봅니다.",
    long: "대기 중인 예약과 최근에 실행된 예약을 한국 시간과 함께 보여 줍니다. 예약을 취소하려면 여기서 확인한 id 를 cancel_scheduled_task 에 넘기세요.",
  },
  cancel_scheduled_task: {
    short: "대기 중인 예약 작업을 취소합니다.",
    long: "아직 실행되지 않은 예약을 id 로 찾아 취소합니다. id 는 list_scheduled_tasks 로 확인할 수 있습니다. 이미 실행되었거나 취소된 예약은 취소할 수 없습니다.",
  },
};

export function toolCopy(tool: ToolDefinition): { short: string; long: string } {
  return TOOL_COPY[tool.name] ?? { short: tool.description, long: tool.description };
}

/** 묶음 이름(서버의 category). 모르는 묶음은 그 이름 그대로. */
export const CATEGORY_LABELS: Record<string, string> = {
  utility: "일반",
  web: "웹",
  filesystem: "파일",
  data: "데이터 처리",
  schedule: "예약",
  browser: "크롬 제어",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/** 매개변수 형식. */
export const TYPE_LABELS: Record<string, string> = {
  string: "문자열",
  integer: "정수",
  number: "숫자",
  boolean: "예/아니오",
  array: "목록",
  object: "묶음",
};

/**
 * 매개변수 설명. 도구 이름 → 매개변수 경로(하위 항목은 "shift.days" 처럼 점으로) →
 * 설명. 없는 것은 서버의 영어 설명을 그대로 보인다.
 */
export const PARAM_COPY: Record<string, Record<string, string>> = {
  calculator: {
    expression: '계산할 수식입니다. 예: "(3 + 4) * 2^10", "sqrt(2) * pi"',
  },
  get_current_time: {
    timezone: "시간대 이름입니다(예: Asia/Seoul). 비워 두면 UTC 기준으로 알려 줍니다.",
  },
  web_search: {
    query: "검색할 내용을 평소 말하듯 적습니다.",
    max_results: "가져올 결과 수입니다(1~10). 기본은 5개입니다.",
    search_depth: '검색 깊이입니다. "basic"은 빠르고 대부분 충분하며, "advanced"는 더 깊이 찾지만 느립니다. 기본은 basic입니다.',
    topic: '최근 소식이나 보도를 찾을 때는 "news"를 씁니다. 기본은 general입니다.',
    include_domains: '이 도메인에서 나온 결과만 받습니다. 예: ["docs.vllm.ai"]',
    exclude_domains: "이 도메인의 결과는 받지 않습니다.",
  },
  http_fetch: {
    url: "가져올 주소입니다(http 또는 https).",
  },
  read_text_file: {
    path: "읽을 파일의 경로입니다. 서버에 허용된 폴더를 기준으로 적습니다.",
  },
  list_directory: {
    path: "목록을 볼 폴더 경로입니다. 서버에 허용된 폴더를 기준으로 적고, 비워 두면 그 폴더 자체를 봅니다.",
  },
  weather_lookup: {
    place: '날씨를 볼 장소입니다. 예: "Seoul", "Paris, France", "Tokyo"',
    unit: "기온 단위입니다. 기본은 섭씨입니다.",
  },
  wikipedia_lookup: {
    query: '찾을 주제나 문서 제목입니다. 예: "Alan Turing", "black hole"',
  },
  currency_convert: {
    amount: "바꿀 금액입니다. 기본은 1입니다.",
    from: '바꾸기 전 통화의 ISO 4217 코드입니다. 예: "USD"',
    to: '바꿀 통화의 ISO 4217 코드입니다. 예: "KRW"',
  },
  unit_convert: {
    value: "바꿀 숫자 값입니다.",
    from: '바꾸기 전 단위입니다. 예: "km", "lb", "celsius", "mph", "GB"',
    to: '바꿀 단위입니다. 예: "mile", "kg", "fahrenheit", "knot", "MiB"',
  },
  datetime_calc: {
    datetime: '계산을 시작할 일시입니다(ISO 8601). 예: "2026-09-11T10:00:00Z". 비워 두면 지금 시각부터 셉니다.',
    source_timezone: '일시에 시간대 표시가 없을 때 그 일시를 어느 시간대로 읽을지 정합니다. 예: "Asia/Seoul". 기본은 UTC입니다.',
    shift: "시작 일시에 더할 시간입니다. 빼려면 음수를 넣고, 여러 항목을 함께 쓸 수 있습니다.",
    "shift.days": "더할 일수입니다.",
    "shift.hours": "더할 시간입니다.",
    "shift.minutes": "더할 분입니다.",
    "shift.seconds": "더할 초입니다.",
    target_timezone: '결과를 나타낼 시간대입니다. 예: "America/New_York". 기본은 UTC입니다.',
  },
  article_extract: {
    url: "본문을 읽을 기사나 페이지의 주소입니다(http 또는 https).",
  },
  text_stats: {
    text: "통계를 낼 텍스트입니다.",
  },
  data_convert: {
    data: "바꿀 데이터를 문자열로 넣습니다.",
    from: "넣은 데이터의 형식입니다.",
    to: "받고 싶은 형식입니다.",
    pretty: "결과가 JSON 이면 들여쓰기(2칸)로 보기 좋게 정리합니다. 기본은 켜짐입니다.",
  },
  encode_decode: {
    operation: "어떤 변환을 할지 고릅니다.",
    text: "변환할 텍스트입니다. JWT 를 풀 때는 토큰을 넣습니다.",
  },
  hash_text: {
    text: "해시를 계산할 텍스트입니다.",
    algorithm: "해시 알고리즘입니다. 기본은 sha256입니다.",
  },
  generate_random: {
    type: "만들 값의 종류입니다.",
    count: "만들 개수입니다(1~20). 기본은 1개입니다.",
    bytes: 'hex·base64 토큰의 바이트 길이입니다(1~64). "uuid4"에는 쓰이지 않으며 기본은 16입니다.',
  },
  color_convert: {
    color: '바꿀 색입니다. hex, rgb(), hsl() 중 아무 형식이나 됩니다. 예: "#ff0000", "rgb(255,0,0)"',
  },
  diff_text: {
    before: "바뀌기 전 텍스트입니다.",
    after: "바뀐 뒤 텍스트입니다.",
  },
  regex_test: {
    pattern: '정규식 본문입니다(앞뒤 슬래시 없이). 예: "\\b\\w+@\\w+\\.\\w+\\b"',
    text: "검사할 텍스트입니다(최대 20,000자).",
    flags: '추가 플래그입니다. "gimsuy" 중에서 고릅니다(i 대소문자 무시, m 여러 줄, s 점이 줄바꿈도 매칭, u 유니코드, y 고정 위치). "g"는 늘 적용됩니다.',
    max_matches: "돌려줄 매칭의 최대 개수입니다(기본 20, 최대 100).",
  },
  json_query: {
    data: "조회할 JSON 문서를 텍스트로 넣습니다.",
    path: '값을 찾을 경로입니다. 예: "items[*].name"',
    limit: "돌려줄 결과의 최대 개수입니다(기본 50, 최대 500).",
  },
  sort_unique: {
    text: "처리할 텍스트입니다. 한 줄에 하나씩 적습니다.",
    operation: '"sort"(정렬), "unique"(중복 제거), "count"(개수 세기) 중 하나입니다.',
    order: '정렬 방향입니다. 기본은 오름차순("asc")입니다.',
    numeric: "줄을 글자가 아니라 숫자로 비교합니다. 기본은 꺼짐입니다.",
    ignore_case: "대소문자를 구분하지 않고 비교합니다. 기본은 꺼짐입니다.",
    trim: "비교하기 전에 각 줄의 앞뒤 공백을 지웁니다. 기본은 켜짐입니다.",
  },
  unicode_inspect: {
    text: "살펴볼 텍스트입니다.",
  },
  cidr_calc: {
    cidr: 'IPv4 CIDR 대역입니다. 예: "10.0.0.0/22", "192.168.1.10/24"',
    contains: '이 대역에 들어가는지 확인할 IPv4 주소입니다(선택). 예: "10.0.1.5"',
  },
  cron_describe: {
    expression: '다섯 자리 크론 표현식입니다. 예: "*/15 9-17 * * 1-5"(평일 오전 9시~오후 5시, 15분마다)',
    count: "보여 줄 다음 실행 시각의 개수입니다(기본 5, 최대 20).",
    timezone: '일정을 해석할 시간대입니다. 예: "Asia/Seoul". 기본은 UTC입니다.',
  },
  url_parse: {
    url: '분해할 전체 주소입니다. 예: "https://user:pass@example.com:8443/a/b?x=1&x=2#frag"',
  },
  schedule_task: {
    run_at: '실행할 시각입니다(한국 시간). "HH:MM"(오늘, 이미 지났으면 내일), "YYYY-MM-DD HH:MM", "+30m"·"+2h"(지금부터), 또는 시간대가 붙은 ISO 8601 형식을 씁니다.',
    instruction: "그 시각에 실행할 요청입니다. 그것만 읽어도 무엇을 할지 알 수 있게 적습니다.",
    use_browser: "사용자의 크롬이 필요한 작업인지 정합니다. 크롬 제어가 켜진 대화에서는 기본으로 켜집니다.",
  },
  cancel_scheduled_task: {
    id: "취소할 예약의 id 입니다.",
  },
};

export function paramCopy(tool: string, path: string, fallback: string | undefined): string | undefined {
  return PARAM_COPY[tool]?.[path] ?? fallback;
}
