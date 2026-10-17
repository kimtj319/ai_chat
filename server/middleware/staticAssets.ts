import fs from "node:fs";
import path from "node:path";
import express, { type RequestHandler } from "express";

/**
 * 빌드 결과를 보낸다 — 미리 압축한 것이 있으면 그것을, 캐시는 파일 성격대로.
 *
 * 예전에는 압축 없이(메인 번들 1.1MB 를 그대로) 보내고, 해시가 붙은 자산까지
 * `max-age=0` 이라 페이지를 열 때마다 모든 파일을 다시 물어봤다.
 *
 * - /assets/* 는 이름에 내용 해시가 있다(vite). 내용이 바뀌면 이름이 바뀌므로
 *   1년 동안 다시 묻지 않아도 된다(immutable).
 * - index.html 과 그 밖의 파일은 이름이 그대로라 매번 확인한다(no-cache: ETag 로
 *   바뀌지 않았으면 304). 새 배포가 곧바로 닿는 것은 이 덕이다.
 * - .br·.gz 는 scripts/precompress.mjs 가 빌드 때 만든다. 없으면 원본을 보낸다.
 */
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

const ENCODINGS = [
  { name: "br", ext: ".br" },
  { name: "gzip", ext: ".gz" },
] as const;

function cacheControlFor(urlPath: string): string {
  return urlPath.startsWith("/assets/") ? IMMUTABLE : REVALIDATE;
}

/** Accept-Encoding 에 그 방식이 있고 q=0 으로 거절되지 않았는가. */
export function accepts(header: string | undefined, encoding: string): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const [name, ...params] = part.trim().split(";");
    if (name?.trim().toLowerCase() !== encoding) return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  });
}

export function staticAssets(distDir: string): RequestHandler[] {
  const root = path.resolve(distDir);

  const precompressed: RequestHandler = (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let rel: string;
    try {
      rel = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    const file = path.join(root, rel);
    // 경로 밖으로 나가는 요청은 express.static 이 거절하게 둔다.
    if (!file.startsWith(root + path.sep)) return next();
    for (const { name, ext } of ENCODINGS) {
      if (!accepts(req.headers["accept-encoding"], name)) continue;
      const candidate = file + ext;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(candidate);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      res.setHeader("Content-Encoding", name);
      res.setHeader("Vary", "Accept-Encoding");
      res.setHeader("Cache-Control", cacheControlFor(req.path));
      // 확장자를 압축 전 파일 것으로 — .br 의 형식(application/octet-stream)이 아니라.
      res.type(path.extname(file));
      return res.sendFile(candidate, { lastModified: true, cacheControl: false }, (err) => {
        if (err) next(err);
      });
    }
    next();
  };

  const plain = express.static(root, {
    cacheControl: false,
    setHeaders: (res, filePath) => {
      const urlPath = "/" + path.relative(root, filePath).split(path.sep).join("/");
      res.setHeader("Cache-Control", cacheControlFor(urlPath));
      // 압축본이 있는 파일은 같은 주소가 인코딩에 따라 달라진다 — 중간 캐시가 섞지 않게.
      if (fs.existsSync(filePath + ".br") || fs.existsSync(filePath + ".gz")) res.setHeader("Vary", "Accept-Encoding");
    },
  });

  return [precompressed, plain];
}
