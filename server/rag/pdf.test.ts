// PDF 추출 검사. `npx tsx server/rag/pdf.test.ts` 로 돈다.
//
// 여기서 지키는 것은 하나다: **압축 폭탄은 풀지 않는다.** 올릴 수 있는 PDF 는
// 20MB 까지인데, deflate 는 1000:1 넘게 줄어든다. 스트림 하나를 끝까지 풀어
// 주면 업로드 한 번이 메인 스레드에서 수 GB 를 동기로 잡는다.
import zlib from "node:zlib";
import { pdfToText } from "./pdf.js";

let passed = 0;
const failures: Array<{ name: string; message: string }> = [];

function check(name: string, condition: unknown, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push({ name, message: detail });
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 페이지 하나, 본문 스트림 하나(FlateDecode)인 가장 작은 PDF. */
function onePagePdf(content: Buffer): Buffer {
  const stream = zlib.deflateSync(content);
  return Buffer.concat([
    Buffer.from(
      "%PDF-1.4\n" +
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
        "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n" +
        `4 0 obj << /Length ${stream.length} /Filter /FlateDecode >> stream\n`,
      "latin1",
    ),
    stream,
    Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
  ]);
}

console.log("server/rag/pdf.ts");

{
  const text = pdfToText(onePagePdf(Buffer.from("BT (hello pdf) Tj ET", "latin1")));
  check("평범한 스트림은 읽는다", text.includes("hello pdf"), JSON.stringify(text));
}
{
  // 앞에 읽을 글자를 두고 뒤를 공백으로 64MB 채운다. 압축하면 수십 KB 다.
  // 다 풀었다면 앞의 글자가 나왔을 것이다.
  const body = Buffer.alloc(64 * 1024 * 1024, 0x20);
  body.write("BT (bomb) Tj ET", 0, "latin1");
  const pdf = onePagePdf(body);
  const text = pdfToText(pdf);
  check(`압축 폭탄(${Math.round(pdf.length / 1024)}KB → 64MB)은 풀지 않는다`, !text.includes("bomb"), JSON.stringify(text.slice(0, 40)));
}

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
