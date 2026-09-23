// pdf.js 가 PDF 를 그릴 때 따로 받아 가는 파일들을 public/pdfjs 로 옮긴다.
//
//   cmaps/          한글·한자 같은 CJK 글꼴의 글자 번호 → 문자 표. 없으면 한글 PDF 의
//                   글자층(강조가 붙는 곳)이 비고, 일부 PDF 는 글자가 아예 안 그려진다.
//   standard_fonts/ PDF 에 글꼴이 박혀 있지 않을 때 쓰는 기본 글꼴.
//
// node_modules 에서 매번 새로 복사한다 — 저장소에 두면 pdfjs-dist 를 올릴 때 두
// 벌이 어긋난다. 그래서 public/pdfjs 는 .gitignore 대상이다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "node_modules", "pdfjs-dist");
const to = path.join(root, "public", "pdfjs");
fs.rmSync(to, { recursive: true, force: true });
for (const dir of ["cmaps", "standard_fonts"]) {
  fs.cpSync(path.join(from, dir), path.join(to, dir), { recursive: true });
}
console.log(`[pdfjs] ${path.relative(root, to)} 에 cmaps·standard_fonts 복사`);
