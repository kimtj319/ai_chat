import express, { type ErrorRequestHandler } from "express";
import { config } from "./config.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionMiddleware } from "./middleware/session.js";
import { attachUser, requireActiveUser } from "./middleware/auth.js";
import { requestLog } from "./middleware/requestLog.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { sessionRouter } from "./routes/session.js";
import { conversationsRouter } from "./routes/conversations.js";
import { boardRouter } from "./routes/board.js";
import { attachmentsRouter } from "./routes/attachments.js";
import { documentsRouter } from "./routes/documents.js";
import { toolsRouter } from "./routes/tools.js";
import { mcpRouter } from "./routes/mcp.js";
import { prohibitionsRouter } from "./routes/prohibitions.js";
import { modelsRouter } from "./routes/models.js";
import { healthRouter } from "./routes/health.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file lives at web/server/app.ts (dev, via tsx) or web/dist-server/app.js
// (built) — either way its parent directory is web/, so "../dist" is web/dist.
const distDir = path.resolve(__dirname, "..", "dist");

export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  // Set on every response, including the SPA and the static bundle. The app is
  // reachable from outside, and none of these were present: the page could be
  // framed by any site, and an injection anywhere would have had no policy
  // standing in its way.
  //
  // 'unsafe-inline' is present for styles only, and is not optional: React
  // writes inline style attributes (a dialog's width, a progress bar), which a
  // strict style-src would break. Scripts get no such exemption — the bundle is
  // a file, and nothing inlines script.
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Every call this app makes is same-origin; the model is reached by the
    // server, never by the browser.
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");

  // 무엇보다 앞이다 — 거절되는 요청(401·403)이야말로 나중에 찾게 되는 요청이라,
  // 인증보다 뒤에 두면 정작 필요한 줄이 로그에 없다.
  app.use(requestLog);

  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    // Only meaningful over TLS, and actively harmful to send without it, so it
    // follows the same switch as the cookie's Secure attribute.
    if (config.cookieSecure) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });
  app.use("/api", sessionMiddleware);
  // Resolve the session's account (may be none), then refuse every /api route
  // except the auth ones. This sits BEFORE the body parsers so it covers the
  // raw attachment upload too — authorisation must not depend on which parser a
  // route happens to use. The public list is middleware/auth.ts
  // PUBLIC_API_PATHS: /auth/signup, /auth/login, /auth/logout, /auth/me.
  app.use("/api", attachUser);
  app.use("/api", requireActiveUser);
  // Before express.json, and with its own raw parser scoped to the upload route:
  // a .json attachment arrives as Content-Type: application/json, which the JSON
  // parser would consume as a request body, leaving the handler with no bytes.
  app.use("/api", attachmentsRouter);
  // Before the JSON parser for the same reason attachments are: an upload is
  // bytes, and a document that happens to be JSON must not be parsed as a body.
  // Its own JSON routes carry a route-scoped parser.
  app.use("/api", documentsRouter);
  app.use(express.json({ limit: "2mb" }));

  app.use("/api", authRouter);
  app.use("/api", adminRouter);
  app.use("/api", sessionRouter);
  app.use("/api", conversationsRouter);
  app.use("/api", boardRouter);
  app.use("/api", toolsRouter);
  app.use("/api", mcpRouter);
  app.use("/api", prohibitionsRouter);
  app.use("/api", modelsRouter);
  app.use("/api", healthRouter);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // The SPA itself is served to anyone: the browser has to be able to load the
  // app before it can show a login form. Only /api is gated.
  app.use(express.static(distDir));

  // 해시가 붙은 자산이 없으면 **없다고 말한다**. 아래의 SPA 폴백에 맡기면
  // index.html 이 200 으로 돌아가고, 그걸 <script> 자리에서 받은 브라우저는
  // 자바스크립트 대신 HTML 을 파싱하다 빈 화면이 된다 — 무엇이 잘못됐는지
  // 아무 데도 안 적힌 채로.
  //
  // 이런 요청은 옛 index.html 을 캐시한 브라우저에서 온다. 배포 때 지난
  // 번들을 치우면 반드시 생기는 일이고, 404 는 그때 브라우저가 새로고침으로
  // 회복할 수 있는 유일한 답이다.
  app.use("/assets", (_req, res) => {
    res.status(404).type("text/plain; charset=utf-8").send("이 자산은 더 이상 없습니다. 새로고침해 주세요.");
  });

  app.use((_req, res) => {
    res.sendFile(path.join(distDir, "index.html"), (err) => {
      if (err) res.status(404).send("Not built: run `npm run build` first.");
    });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    // Deliberately NOT `console.error(err)`. body-parser attaches the raw
    // request body to a malformed-JSON error, and printing the object prints
    // that body with it — so one bad POST /api/auth/login used to write the
    // password, in the clear, into the log file. Only fields that cannot carry
    // request content are logged.
    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[server] unhandled error on ${req.method} ${req.path}: ${name}: ${message}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : "Internal server error" });
  };
  app.use(errorHandler);

  return app;
}
