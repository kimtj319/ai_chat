/**
 * 코드 블록 색칠에 실을 highlight.js 문법들. 빌드에서 lowlight 의 `common`(37개)을 이
 * 목록으로 갈아 끼운다(vite.config.ts 의 trimHighlightLanguages).
 *
 * rehype-highlight 에 `languages` 옵션을 주는 것으로는 줄지 않는다 — 옵션이 없을 때 쓰는
 * `common` 을 그 모듈이 직접 불러 두므로 37개가 그대로 묶음에 남는다.
 *
 * 고른 기준: 이 앱의 사용자(검색 엔진·서버 개발)가 실제로 묻는 언어. common 에서 뺀 것은
 * arduino·graphql·less·lua·objectivec·perl·php·php-template·python-repl·r·ruby·scss·
 * swift·vbnet·wasm — 이 언어의 코드 블록도 그대로 보이고, 색만 칠해지지 않는다.
 * dockerfile·properties 는 common 에 없던 것을 더했다.
 */
import type { LanguageFn } from "highlight.js";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import properties from "highlight.js/lib/languages/properties";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// 이름은 갈아 끼우는 lowlight/lib/common.js 의 것과 같아야 한다.
export const grammars: Record<string, LanguageFn> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  makefile,
  markdown,
  plaintext,
  properties,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
};
