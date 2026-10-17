#!/usr/bin/env node
/**
 * 기존 대화들에 새 내장 도구를 켠다(1회용).
 *
 * 새 대화는 만들 때 모든 내장 도구가 켜지지만(conversationStore.createConversation),
 * 이미 있는 대화는 만들 때의 도구 목록(enabledTools)을 그대로 들고 있어서 나중에 생긴
 * 도구가 꺼진 채로 남는다. 도구를 추가해 배포할 때 앱을 멈춘 상태에서 한 번 돌린다.
 *
 *   node scripts/enable-tool.mjs <DATA_DIR> <tool_name> [--dry-run]
 *
 * 쓰기는 같은 폴더의 임시 파일 + rename 이라 중간에 끊겨도 반쯤 쓴 파일이 남지 않는다.
 */
import fs from "node:fs/promises";
import path from "node:path";

const [dataDir, tool, flag] = process.argv.slice(2);
if (!dataDir || !tool || !/^[a-z][a-z0-9_]*$/.test(tool)) {
  console.error("usage: node scripts/enable-tool.mjs <DATA_DIR> <tool_name> [--dry-run]");
  process.exit(2);
}
const dryRun = flag === "--dry-run";
const ownersDir = path.join(dataDir, "owners");

let scanned = 0;
let changed = 0;
let skipped = 0;
for (const owner of await fs.readdir(ownersDir).catch(() => [])) {
  const dir = path.join(ownersDir, owner, "conversations");
  for (const entry of await fs.readdir(dir).catch(() => [])) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(dir, entry);
    scanned++;
    let conv;
    try {
      conv = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (err) {
      console.warn(`skip (unreadable): ${file}: ${err.message}`);
      skipped++;
      continue;
    }
    if (!Array.isArray(conv.enabledTools) || conv.enabledTools.includes(tool)) continue;
    conv.enabledTools = [...conv.enabledTools, tool];
    changed++;
    if (dryRun) continue;
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(conv, null, 2));
    await fs.rename(tmp, file);
  }
}
console.log(`${dryRun ? "[dry-run] " : ""}${tool}: scanned ${scanned}, enabled in ${changed}, skipped ${skipped}`);
