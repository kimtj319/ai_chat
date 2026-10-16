import { postBrowserActionResult } from "../api/client";
import { askBrowserConfirm } from "./confirm";
import { sendBrowserCommand, type BrowserCommand } from "./extension";
import { addBrowserShots } from "./shots";

/**
 * 서버가 보낸 크롬 명령 하나를 끝까지: 확장에 실행시키고, 확인이 필요하면 사용자에게
 * 묻고 다시 보내고, 결과를 서버의 도구 루프에 돌려준다. 실패도 결과다 — 무엇이든
 * 돌려줘야 서버의 기다림이 풀린다.
 */
export async function runBrowserAction(
  conversationId: string,
  event: { callId: string; toolCallId: string; name: string; arguments: unknown },
  signal: AbortSignal,
): Promise<void> {
  const command: BrowserCommand = { name: event.name, args: event.arguments ?? {} };
  let outcome: { ok: boolean; result?: unknown; error?: string } | null = null;
  // 사이트 허용 한 번 + 동작 확인 한 번이 겹칠 수 있다. 그 이상은 확장의 잘못이다.
  for (let attempt = 0; attempt < 3 && !outcome; attempt++) {
    const response = await sendBrowserCommand(command);
    // 찍힌 화면은 바로 보여 준다 — 확인 창을 기다리는 동안에도 무엇을 하려는지 보이게.
    if ("needsConfirm" in response) addBrowserShots(event.toolCallId, response.needsConfirm.preview ? [response.needsConfirm.preview] : []);
    else addBrowserShots(event.toolCallId, response.visual?.shots);
    if (!("needsConfirm" in response)) {
      outcome = response.ok ? { ok: true, result: response.result } : { ok: false, error: response.error };
      break;
    }
    const allowed = await askBrowserConfirm(response.needsConfirm, signal);
    if (!allowed) {
      outcome = {
        ok: false,
        error:
          response.needsConfirm.kind === "site"
            ? `사용자가 ${response.needsConfirm.host} 사이트를 허용하지 않았습니다. 이 사이트는 다시 시도하지 마세요.`
            : "사용자가 이 동작을 허용하지 않았습니다. 같은 동작을 다시 시도하지 마세요.",
      };
      break;
    }
    command.confirm =
      response.needsConfirm.kind === "site"
        ? { ...command.confirm, allowSite: response.needsConfirm.host }
        : { ...command.confirm, action: true };
  }
  if (signal.aborted) return; // 서버는 이미 기다림을 접었다.
  await postBrowserActionResult(conversationId, event.callId, outcome ?? { ok: false, error: "확인 절차가 끝나지 않았습니다." }).catch(
    (err: unknown) => console.warn("[browser] could not return the result:", err),
  );
}
