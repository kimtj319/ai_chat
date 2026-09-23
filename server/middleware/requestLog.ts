/**
 * 요청 하나에 id 를 붙이고, 끝나면 한 줄 남긴다.
 *
 * 이 미들웨어가 서는 자리가 중요하다: **모든 것보다 앞**이다. 인증보다도 앞인
 * 이유는, 거절된 요청이야말로 나중에 찾게 되는 요청이기 때문이다 — 401 이
 * 로그에 없으면 "로그인이 안 돼요" 를 쫓을 방법이 없다.
 */
import type { NextFunction, Request, Response } from "express";
import { levelEnabled, newRequestId, runWithRequestId, sanitizeRequestId } from "../log.js";

/** 한 줄에 담기에 너무 긴 경로는 자른다. 쿼리는 비밀이 실릴 수 있어 아예 뺀다. */
function safePath(url: string): string {
  const path = url.split("?")[0] ?? url;
  return path.length > 120 ? `${path.slice(0, 120)}…` : path;
}

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  // 앞단(프록시·게이트웨이)이 이미 id 를 붙였으면 그것을 잇는다. 한 요청이
  // 여러 층을 지날 때 층마다 다른 id 를 쓰면 이어 붙일 수가 없다.
  const id = sanitizeRequestId(req.get("x-request-id")) ?? newRequestId();
  // 돌려주는 이유: 사용자가 화면에서 본 오류를 이 값으로 신고할 수 있다.
  res.setHeader("X-Request-Id", id);

  const startedAt = process.hrtime.bigint();
  runWithRequestId(id, () => {
    res.on("finish", () => {
      // 200 은 info, 4xx 는 warn, 5xx 는 error — 레벨을 올리면 시끄러운 줄부터 사라진다.
      const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      if (!levelEnabled(level)) return;
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const line = `[http] ${req.method} ${safePath(req.originalUrl)} ${res.statusCode} ${ms.toFixed(0)}ms`;
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    });
    // 응답을 다 보내기 전에 연결이 끊기면 `finish` 는 오지 않는다. 예전에는 그런
    // 요청이 로그에 한 줄도 남지 않았다 — 서버는 작업을 끝까지 해내는데 사용자는
    // 실패를 봤고, 나중에 로그를 뒤져도 요청이 있었다는 사실조차 없었다(9/23
    // 문서 공개 전환 사건). 끊긴 요청은 그 자체로 쫓아야 할 사건이라 warn 이다.
    res.on("close", () => {
      if (res.writableFinished) return;
      if (!levelEnabled("warn")) return;
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      console.warn(`[http] ${req.method} ${safePath(req.originalUrl)} aborted ${ms.toFixed(0)}ms (응답 전에 연결이 끊김)`);
    });
    next();
  });
}
