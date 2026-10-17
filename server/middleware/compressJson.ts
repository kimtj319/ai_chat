import zlib from "node:zlib";
import type { RequestHandler } from "express";
import { accepts } from "./staticAssets.js";

/**
 * 큰 JSON 응답을 압축해서 보낸다(대화 하나·목록·문서 목록 같은 것).
 *
 * res.json 만 감싼다 — 답변 스트림(SSE)은 res.write 로 조각조각 나가고, 압축하면
 * 조각이 모일 때까지 브라우저에 닿지 않으니 건드리지 않는다. 작은 응답은 압축해도
 * 줄어드는 바이트보다 헤더·CPU 가 더 들어 그대로 둔다.
 *
 * brotli 품질 4: 한 번 쓰고 마는 응답이라 빠른 쪽으로(1MB 에 수 ms).
 */
const MIN_BYTES = 1024;

export function compressJson(): RequestHandler {
  return (req, res, next) => {
    const send = res.json.bind(res);
    res.json = (body?: unknown) => {
      const header = req.headers["accept-encoding"];
      const encoding = accepts(header, "br") ? "br" : accepts(header, "gzip") ? "gzip" : null;
      if (!encoding || res.headersSent || res.getHeader("Content-Encoding")) return send(body);
      const text = JSON.stringify(body);
      if (text === undefined || Buffer.byteLength(text) < MIN_BYTES) return send(body);
      const packed =
        encoding === "br"
          ? zlib.brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
          : zlib.gzipSync(text, { level: 6 });
      res.setHeader("Content-Encoding", encoding);
      res.setHeader("Vary", "Accept-Encoding");
      if (!res.getHeader("Content-Type")) res.type("application/json; charset=utf-8");
      return res.send(packed);
    };
    next();
  };
}
