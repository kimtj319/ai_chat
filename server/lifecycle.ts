/**
 * 프로세스가 어떻게 멈추는가.
 *
 * 두 가지를 정한다. **부탁받고 멈출 때**(SIGTERM) 하던 일을 끝내고 나가는 것,
 * 그리고 **더 이상 믿을 수 없을 때**(uncaughtException) 계속 돌지 않는 것.
 *
 * 왜 필요한가: 예전에는 둘 다 없었다. `docker stop` 은 응답을 쓰고 있던 SSE
 * 연결과 저장 중이던 파일을 그대로 끊었고, 잡히지 않은 예외는 기록만 남기고
 * 프로세스를 살려 두었다 — 무엇이 망가졌는지 모르는 채로 계속 요청을 받는
 * 상태다. 둘 다 롤링 재시작을 하는 곳에서는 곧바로 사고가 된다.
 */
import type http from "node:http";

/** 진행 중인 요청에 주는 시간. 이 뒤에는 남은 연결을 끊고 나간다. */
const DEFAULT_GRACE_MS = 15_000;
/** 망가진 상태에서 주는 시간. 기록을 흘려보낼 만큼만 짧게. */
const CRASH_GRACE_MS = 2_000;

export type CrashPolicy = "exit" | "keep";

/**
 * 잡히지 않은 예외를 만났을 때 무엇을 할 것인가.
 *
 * "exit" 이 옳은 기본값이다 — Node 의 기본 동작이고, 깨진 상태로 요청을 받느니
 * 죽고 다시 뜨는 편이 낫다. **다만 그건 다시 띄워 줄 무언가가 있을 때 얘기다.**
 * 감시자(systemd·restart 정책) 없이 이 값을 쓰면 한 번의 예외가 곧 서비스
 * 중단이 된다. 그래서 끌 수 있게 두고, 무엇을 고르든 로그에 적는다.
 */
export function crashPolicy(): CrashPolicy {
  return (process.env.CRASH_POLICY || "exit").trim().toLowerCase() === "keep" ? "keep" : "exit";
}

function graceMs(): number {
  const parsed = Number(process.env.SHUTDOWN_GRACE_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_GRACE_MS;
}

/** 한 번만 돈다 — SIGTERM 뒤에 SIGINT 가 와도 종료 절차가 두 번 시작되지 않는다. */
let closing = false;

/**
 * 새 연결을 그만 받고, 진행 중인 것에 시간을 준 뒤 나간다.
 *
 * `server.close()` 는 **듣기를 멈출 뿐** 열려 있는 연결을 끊지 않는다. 브라우저는
 * keep-alive 로 연결을 붙들고 있으므로, 그것만으로는 영원히 안 끝날 수 있다.
 * 그래서 놀고 있는 연결은 바로 닫고, 시간이 다 되면 남은 것도 닫는다.
 */
export function shutdown(server: http.Server, reason: string, code = 0, timeoutMs = graceMs()): void {
  if (closing) return;
  closing = true;
  console.log(`[server] ${reason} — 새 요청을 받지 않고 ${timeoutMs}ms 안에 마무리합니다`);

  const forced = setTimeout(() => {
    console.warn(`[server] ${timeoutMs}ms 안에 끝나지 않은 연결이 있어 끊고 나갑니다`);
    server.closeAllConnections?.();
    process.exit(code);
  }, timeoutMs);
  // 이 타이머 때문에 프로세스가 살아 있을 이유는 없다.
  forced.unref();

  server.close(() => {
    clearTimeout(forced);
    console.log("[server] 진행 중이던 요청까지 끝났습니다. 종료합니다.");
    process.exit(code);
  });
  // 요청을 받고 있지 않은 연결은 기다릴 이유가 없다.
  server.closeIdleConnections?.();
}

/**
 * 종료 신호와 사고를 프로세스에 건다.
 *
 * 서버를 인자로 받는 이유는, 종료가 "프로세스를 죽이는 일" 이 아니라 "듣기를
 * 멈추고 하던 응답을 끝내는 일" 이기 때문이다 — 그러려면 무엇이 듣고 있는지
 * 알아야 한다.
 */
export function installLifecycle(server: http.Server): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => shutdown(server, `종료 신호(${signal})를 받았습니다`, 0));
  }

  process.on("uncaughtException", (err) => {
    console.error("[server] uncaughtException:", err);
    if (crashPolicy() === "keep") {
      console.error("[server] CRASH_POLICY=keep — 계속 돕니다. 이 프로세스의 상태는 이제 보장되지 않습니다.");
      return;
    }
    // 여기서부터는 무엇이 망가졌는지 모른다. 하던 응답을 억지로 붙들지 않고
    // 짧게 정리한 뒤 0 이 아닌 값으로 나간다 — 감시자가 다시 띄운다.
    shutdown(server, "잡히지 않은 예외로 종료합니다", 1, CRASH_GRACE_MS);
  });

  process.on("unhandledRejection", (reason) => {
    // 예외와 달리 죽이지 않는다. 이 서버의 뒷작업(첨부 청소, MCP 탐색 등)은
    // 전부 `void promise.catch(...)` 로 떨어져 있어서, 여기까지 온 거절은
    // 그 갈래 하나가 실패했다는 뜻이지 요청을 받는 길이 망가졌다는 뜻이 아니다.
    // 대신 조용히 지나가지 않도록 크게 적는다.
    console.error("[server] unhandledRejection:", reason);
  });

  console.log(
    `[server] 종료 처리: SIGTERM·SIGINT 에 ${graceMs()}ms 유예, ` +
      `잡히지 않은 예외 시 ${crashPolicy() === "exit" ? "종료(감시자 필요)" : "계속 실행"}`,
  );
}
