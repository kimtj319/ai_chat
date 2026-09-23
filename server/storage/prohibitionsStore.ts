/**
 * 사용자마다 하나씩 있는 "하지 말 것" 목록. `{DATA_DIR}/owners/<id>/prohibitions.md`.
 *
 * 사람이 직접 읽고 고치는 파일이라 markdown 이다. 대신 모양에 규칙이 하나 있다:
 * `## 검토 대기` 줄을 경계로 위와 아래가 뜻이 다르다.
 *
 *   위  — 반영되는 목록. 모든 대화의 시스템 프롬프트에 들어간다.
 *   아래 — 검토 대기. 대화에서 "하지 말라" 는 뜻으로 읽힌 말을 자동으로 모아 둔
 *          곳이다. 반영되지 **않는다.** 사용자가 맞다고 보면 위로 옮긴다.
 *
 * 자동으로 찾은 것을 곧바로 반영하지 않는 이유는 오탐이다. 사용자가 자기 상황에
 * 대해 한 불만을 이 앱의 행동에 대한 불만으로 잘못 읽은 한 줄이 조용히 들어가면,
 * 이후 모든 대화가 틀린 제약을 받는데 사용자는 답이 왜 달라졌는지 알 길이 없다.
 *
 * HTML 주석(<!-- -->)은 사람을 위한 설명이라 반영할 때 걷어낸다.
 */
import fs from "node:fs/promises";
import { writeFileAtomic } from "./atomic.js";
import { withLock } from "./mutex.js";
import { ownerProhibitionsFile } from "./paths.js";

/** 반영되는 부분의 상한. 매 턴 프롬프트에 실리므로 그 비용은 대화 전체에 걸쳐 반복된다. */
export const PROHIBITIONS_LIMIT_CHARS = 4_000;
/** 이만큼 차면 묶어서 줄이라고 권한다 — 상한에 닿아 잘린 뒤에야 알게 되는 것보다 낫다. */
export const PROHIBITIONS_WARN_RATIO = 0.7;
/** 파일 전체의 상한. 이보다 큰 저장은 거절한다(검토 대기가 끝없이 쌓이는 것을 막는다). */
export const PROHIBITIONS_FILE_MAX_CHARS = 40_000;
/** 규칙 한 줄의 길이 한계. 자동 감지와 직접 입력이 같은 기준을 쓴다. */
export const RULE_MIN_CHARS = 4;
export const RULE_MAX_CHARS = 300;

export const PENDING_HEADING = "## 검토 대기";
const PENDING_LINE = /^##\s*검토\s*대기\s*$/m;

export const TEMPLATE = `# 하지 말아야 할 것

<!--
이 목록은 내 모든 대화에 반영됩니다. 한 줄에 하나씩("- " 로 시작) 자유롭게 고치세요.

아래 "검토 대기" 는 대화에서 "하지 말라" 는 뜻으로 읽힌 말을 자동으로 모아 두는 곳입니다.
맞으면 이 위로 옮기고, 아니면 지우세요. 검토 대기에 있는 동안에는 반영되지 않습니다.
-->

${PENDING_HEADING}
`;

const lockFor = (ownerId: string) => `prohibitions:${ownerId}`;

/** 파일이 없으면 빈 틀을 돌려준다(아직 쓰지는 않는다). */
export async function readProhibitions(ownerId: string): Promise<string> {
  try {
    return await fs.readFile(ownerProhibitionsFile(ownerId), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return TEMPLATE;
    throw err;
  }
}

/** 줄바꿈을 모으고, 탭·줄바꿈 외의 제어문자를 걷는다. 사람이 붙여 넣은 텍스트다. */
export function normalizeMarkdown(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export class ProhibitionsTooLargeError extends Error {}

export async function writeProhibitions(ownerId: string, raw: string): Promise<string> {
  const md = normalizeMarkdown(raw);
  if (md.length > PROHIBITIONS_FILE_MAX_CHARS) {
    throw new ProhibitionsTooLargeError(
      `목록이 너무 깁니다 (${md.length.toLocaleString()}자). ${PROHIBITIONS_FILE_MAX_CHARS.toLocaleString()}자까지 저장할 수 있습니다.`,
    );
  }
  await withLock(lockFor(ownerId), () => writeFileAtomic(ownerProhibitionsFile(ownerId), md));
  return md;
}

/** `## 검토 대기` 를 경계로 가른다. 경계가 없으면 전부가 반영되는 쪽이다. */
export function splitProhibitions(md: string): { active: string; pending: string } {
  const m = PENDING_LINE.exec(md);
  if (!m) return { active: md, pending: "" };
  return { active: md.slice(0, m.index), pending: md.slice(m.index + m[0].length) };
}

function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * 프롬프트에 실을 텍스트. 주석과 맨 위 제목(# ...)을 걷고, 빈 줄 여러 개를 하나로
 * 모은다. 남는 것이 없으면 빈 문자열 — 그때는 프롬프트에 아무것도 붙지 않는다.
 */
export function activeText(md: string): string {
  const { active } = splitProhibitions(md);
  return stripComments(active)
    .split("\n")
    .filter((line) => !/^#\s/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 줄 경계에서 자른다. 한 줄을 반만 실으면 뜻이 뒤집힐 수 있다. */
export function capActive(text: string, limit = PROHIBITIONS_LIMIT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const cut = text.slice(0, limit);
  const lastBreak = cut.lastIndexOf("\n");
  return { text: (lastBreak > 0 ? cut.slice(0, lastBreak) : cut).trimEnd(), truncated: true };
}

/** 목록 항목만(- · * · 1.). 주석 속 줄은 세지 않는다. */
export function listItems(section: string): string[] {
  return stripComments(section)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^([-*]|\d+\.)\s+\S/.test(line))
    .map((line) => line.replace(/^([-*]|\d+\.)\s+/, "").trim());
}

export function pendingCount(md: string): number {
  return listItems(splitProhibitions(md).pending).length;
}

/** 같은 말인지 가르는 기준. 띄어쓰기·문장부호·대소문자만 다른 것은 같은 규칙이다. */
function sameRuleKey(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * 검토 대기에 한 줄 보탠다. 위(반영)든 아래(대기)든 같은 말이 이미 있으면 보태지
 * 않는다 — 같은 지적을 여러 번 하는 것은 흔하고, 그때마다 한 줄씩 늘면 목록이
 * 읽을 수 없게 된다. 보탰으면 true.
 *
 * 근거는 그 사용자의 말 앞부분을 주석으로 붙인다. 나중에 "내가 이렇게 말했었지" 를
 * 알아보는 쪽이 규칙 문장만 보는 것보다 빠르다.
 */
export async function appendPending(ownerId: string, rule: string, quote: string, at: Date): Promise<boolean> {
  const text = rule.replace(/\s+/g, " ").trim();
  if (text.length < RULE_MIN_CHARS || text.length > RULE_MAX_CHARS) return false;
  return withLock(lockFor(ownerId), async () => {
    const md = await readProhibitions(ownerId);
    const key = sameRuleKey(text);
    const { active, pending } = splitProhibitions(md);
    if ([...listItems(active), ...listItems(pending)].some((item) => sameRuleKey(item) === key)) return false;

    // 주석 안에 "-->" 가 들어가면 주석이 거기서 끝나 버린다.
    const note = quote.replace(/\s+/g, " ").trim().slice(0, 80).replace(/--+>?/g, "–");
    const line = `- ${text} <!-- ${at.toISOString().slice(0, 10)} · "${note}" -->`;
    const base = PENDING_LINE.test(md) ? md.replace(/\s*$/, "\n") : `${md.replace(/\s*$/, "\n")}\n${PENDING_HEADING}\n`;
    const next = `${base}${line}\n`;
    if (next.length > PROHIBITIONS_FILE_MAX_CHARS) return false;
    await writeFileAtomic(ownerProhibitionsFile(ownerId), next);
    return true;
  });
}
