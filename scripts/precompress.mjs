#!/usr/bin/env node
/**
 * 빌드 결과(dist/)의 글자 파일마다 .br·.gz 를 미리 만들어 둔다.
 *
 * 서버(server/middleware/staticAssets.ts)는 브라우저가 받는 압축본을 골라 그대로
 * 보낸다. 요청마다 압축하지 않으니 CPU 를 쓰지 않고, 가장 센 압축(brotli 11)을 쓸 수
 * 있다. 압축해도 거의 줄지 않는 파일(이미 압축된 woff2·png·zip)은 건너뛴다.
 *
 *   node scripts/precompress.mjs [dir=dist]
 */
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const COMPRESSIBLE = /\.(js|mjs|css|html|svg|json|webmanifest|map|txt|ttf|otf|bcmap|pfb)$/i;
const MIN_BYTES = 1024;
/** 원본보다 이만큼 이상 작아지지 않으면 압축본을 두지 않는다. */
const MIN_SAVING = 0.9;

const root = path.resolve(process.argv[2] ?? "dist");
let files = 0;
let before = 0;
let after = 0;

async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (!COMPRESSIBLE.test(entry.name)) continue;
    const data = await fs.readFile(full);
    if (data.length < MIN_BYTES) continue;
    const [br, gz] = await Promise.all([
      brotli(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
      gzip(data, { level: 9 }),
    ]);
    if (br.length < data.length * MIN_SAVING) await fs.writeFile(`${full}.br`, br);
    if (gz.length < data.length * MIN_SAVING) await fs.writeFile(`${full}.gz`, gz);
    files++;
    before += data.length;
    after += Math.min(br.length, data.length);
  }
}

await walk(root);
const mb = (n) => (n / 1024 / 1024).toFixed(2);
console.log(`precompress: ${files} files, ${mb(before)}MB → ${mb(after)}MB (brotli)`);
