// 메일 보내기 검사. `npm test` 로 돈다.
//
// 지키는 것은 셋이다.
//
//   1. **SMTP 대화가 규약대로다.** 의존성 없이 node:net 으로 직접 말하므로, 점 하나
//      (줄 맨 앞의 ".")·줄바꿈 하나(CRLF)가 틀려도 메일이 잘리거나 서버가 거절한다.
//      가짜 SMTP 서버를 띄워 오간 말을 그대로 받아 적고 확인한다.
//   2. **한국어가 깨지지 않는다.** 제목은 RFC 2047, 본문은 base64 로 실어 보낸다 —
//      받은 쪽에서 풀어서 원문과 같은지 본다.
//   3. **게시판 답변이 글쓴이에게 한 통만 간다.** 자기 답변·메일 꺼짐·주소 없음에는
//      보내지 않고, 메일이 실패해도 답변은 올라간다.
import express from "express";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mail-test-"));
process.env.DATA_DIR = dataDir;
for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM", "MAIL_FROM_NAME", "APP_BASE_URL", "SHARE_BASE_URL"]) {
  delete process.env[key];
}

const { deliver, encodeWord, mailConfigFromEnv, sendMail } = await import("./smtp.js");
type MailConfig = NonNullable<ReturnType<typeof mailConfigFromEnv>>;
const { boardRouter } = await import("../routes/board.js");
const { createUser } = await import("../storage/userStore.js");

let passed = 0;
const failures: Array<{ name: string; message: string }> = [];

function check(name: string, condition: unknown, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push({ name, message: detail });
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ------------------------------------------------------------ 가짜 SMTP 서버 */

interface Session {
  commands: string[];
  /** DATA 와 끝 점 사이에 온 그대로(점 덧붙이기 포함). */
  data: string;
}

interface FakeOptions {
  /** EHLO 에 내놓을 AUTH 방식. 비우면 AUTH 줄이 없다. */
  auth?: string;
  /** STARTTLS 를 내놓기만 한다(받지는 않는다) — 평문으로 비밀번호를 보내는지 볼 때 쓴다. */
  offerStartTls?: boolean;
  /** MAIL FROM 을 받으면 아무 말 없이 연결을 끊는다. */
  dropOnMail?: boolean;
  /** 인사조차 하지 않는다 — 시간 초과를 볼 때 쓴다. */
  silent?: boolean;
}

async function startFake(options: FakeOptions = {}) {
  const sessions: Session[] = [];
  const server = net.createServer((socket) => {
    const session: Session = { commands: [], data: "" };
    sessions.push(session);
    if (options.silent) return;
    let buf = "";
    let inData = false;
    let loginStep = 0;
    socket.write("220 fake.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 2.0.0 queued\r\n");
          } else {
            session.data += `${line}\r\n`;
          }
          continue;
        }
        session.commands.push(line);
        const verb = line.split(" ")[0].toUpperCase();
        if (loginStep === 1) {
          loginStep = 2;
          socket.write("334 UGFzc3dvcmQ6\r\n");
        } else if (loginStep === 2) {
          loginStep = 0;
          socket.write("235 2.7.0 ok\r\n");
        } else if (verb === "EHLO") {
          const ext = ["250-fake.test"];
          if (options.offerStartTls) ext.push("250-STARTTLS");
          if (options.auth) ext.push(`250-AUTH ${options.auth}`);
          ext.push("250 8BITMIME");
          socket.write(`${ext.join("\r\n")}\r\n`);
        } else if (verb === "AUTH" && /^AUTH LOGIN$/i.test(line)) {
          loginStep = 1;
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (verb === "AUTH") {
          socket.write("235 2.7.0 ok\r\n");
        } else if (verb === "MAIL") {
          if (options.dropOnMail) socket.destroy();
          else socket.write("250 2.1.0 ok\r\n");
        } else if (verb === "RCPT") {
          socket.write("250 2.1.5 ok\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 2.0.0 bye\r\n");
        } else {
          socket.write("502 5.5.2 unknown\r\n");
        }
      }
    });
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  return { port, sessions, close: () => new Promise((r) => server.close(r)) };
}

/** 받은 메시지를 머리와 본문으로 가른다. 점 덧붙이기를 되돌리고, 접힌 머리는 편다. */
function parseMessage(data: string) {
  const unstuffed = data
    .split("\r\n")
    .map((l) => (l.startsWith("..") ? l.slice(1) : l))
    .join("\r\n");
  const cut = unstuffed.indexOf("\r\n\r\n");
  const head = unstuffed.slice(0, cut).replace(/\r\n[ \t]+/g, " ");
  const headers = new Map<string, string>();
  for (const line of head.split("\r\n")) {
    const at = line.indexOf(":");
    headers.set(line.slice(0, at).toLowerCase(), line.slice(at + 1).trim());
  }
  const body = Buffer.from(unstuffed.slice(cut + 4).replace(/\s+/g, ""), "base64").toString("utf8");
  return { headers, body, raw: unstuffed };
}

/** RFC 2047 B 인코딩만 푼다 — 우리가 보내는 모양이 그것뿐이다. */
function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_m, b64: string) => Buffer.from(b64, "base64").toString("utf8"));
}

function configFor(port: number, extra: Partial<MailConfig> = {}): MailConfig {
  return {
    host: "127.0.0.1",
    port,
    secure: "none",
    from: "noreply@example.com",
    fromName: "AI Console",
    rejectUnauthorized: true,
    timeoutMs: 2000,
    ...extra,
  };
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

console.log("server/mail/smtp.ts");

/* ---------------------------------------------------------------- 설정 읽기 */

{
  check("SMTP_HOST 가 없으면 꺼진다", mailConfigFromEnv({ MAIL_FROM: "a@b.co" }) === null);
  check("MAIL_FROM 이 없으면 꺼진다", mailConfigFromEnv({ SMTP_HOST: "smtp.example.com" }) === null);
  check("MAIL_FROM 이 주소가 아니면 꺼진다", mailConfigFromEnv({ SMTP_HOST: "smtp.example.com", MAIL_FROM: "누구" }) === null);
  const base = mailConfigFromEnv({ SMTP_HOST: "smtp.example.com", MAIL_FROM: "a@b.co" });
  check("기본은 STARTTLS·587", base?.secure === "starttls" && base?.port === 587, JSON.stringify(base));
  check("보내는 이름 기본값", base?.fromName === "AI Console");
  check("인증서 검사는 기본으로 켠다", base?.rejectUnauthorized === true);
  const ssl = mailConfigFromEnv({ SMTP_HOST: "h", MAIL_FROM: "a@b.co", SMTP_SECURE: "ssl" });
  check("ssl 이면 465", ssl?.secure === "ssl" && ssl?.port === 465, JSON.stringify(ssl));
  const loose = mailConfigFromEnv({ SMTP_HOST: "h", MAIL_FROM: "a@b.co", SMTP_TLS_REJECT_UNAUTHORIZED: "false", SMTP_PORT: "2525" });
  check("사설 CA 용으로 인증서 검사를 끌 수 있다", loose?.rejectUnauthorized === false);
  check("포트를 바꿀 수 있다", loose?.port === 2525);
}

/* -------------------------------------------------------------- RFC 2047 */

{
  check("ASCII 는 그대로", encodeWord("AI Console") === "AI Console");
  const long = "[AI Console 문의 게시판] #12 검색 결과가 이상하게 나오는 문제가 있습니다 에 답변이 달렸습니다";
  const encoded = encodeWord(long);
  const words = encoded.split(/\r\n /);
  check("긴 제목은 여러 낱말로 나뉜다", words.length > 1, encoded);
  check("낱말 하나는 75자를 넘지 않는다", words.every((w) => w.length <= 75), words.map((w) => w.length).join());
  check("풀면 원문과 같다", decodeWords(encoded.replace(/\r\n /g, " ")) === long, decodeWords(encoded));
  check("줄바꿈은 머리에 들어가지 않는다", !encodeWord("제목\r\nBcc: x@y.z").includes("\n"));
}

/* ------------------------------------------------------ 점 덧붙이기(dot-stuffing) */

{
  const fake = await startFake();
  const message = "Subject: t\r\n\r\n첫 줄\r\n.숨은 줄\r\n..두 점\r\n.\r\n끝";
  await deliver(configFor(fake.port), "to@example.com", message);
  const got = fake.sessions[0]?.data ?? "";
  const text = Buffer.from(got, "latin1").toString("utf8");
  check("줄 맨 앞의 점에 점을 하나 더 붙인다", text.includes("\r\n..숨은 줄\r\n...두 점\r\n"), JSON.stringify(text));
  check("점 하나뿐인 줄이 메일을 끝내지 않는다", text.includes("\r\n..\r\n끝\r\n"), JSON.stringify(text));
  check("되돌리면 원문과 같다", Buffer.from(parseMessage(got).raw, "latin1").toString("utf8") === `${message}\r\n`);
  await fake.close();
}

/* -------------------------------------------------------------- 대화 전체 */

{
  const fake = await startFake({ auth: "PLAIN LOGIN" });
  const text = "안녕하세요.\n답변이 달렸습니다 — 확인해 주세요.\n.점으로 시작하는 줄";
  await sendMail(configFor(fake.port, { user: "mailer", password: "s3cret-비번" }), {
    to: "alice@example.com",
    subject: "[AI Console 문의 게시판] #3 색인 오류 에 답변이 달렸습니다",
    text,
  });
  const s = fake.sessions[0];
  const order = ["EHLO ", "AUTH PLAIN ", "MAIL FROM:", "RCPT TO:", "DATA", "QUIT"];
  check(
    "EHLO → AUTH PLAIN → MAIL → RCPT → DATA → QUIT",
    s.commands.length === order.length && order.every((prefix, i) => s.commands[i].startsWith(prefix)),
    s.commands.map((c) => c.slice(0, 12)).join(" | "),
  );
  const plain = s.commands.find((c) => c.startsWith("AUTH PLAIN "))?.slice("AUTH PLAIN ".length) ?? "";
  check("AUTH PLAIN 은 \\0아이디\\0비밀번호", Buffer.from(plain, "base64").toString("utf8") === "\0mailer\0s3cret-비번");
  check("봉투의 보내는 이", s.commands.includes("MAIL FROM:<noreply@example.com>"), s.commands.join(" | "));
  check("봉투의 받는 이", s.commands.includes("RCPT TO:<alice@example.com>"));
  const msg = parseMessage(s.data);
  check("제목이 한국어로 풀린다", decodeWords(msg.headers.get("subject") ?? "") === "[AI Console 문의 게시판] #3 색인 오류 에 답변이 달렸습니다", msg.headers.get("subject"));
  check("보낸 이 이름과 주소", decodeWords(msg.headers.get("from") ?? "") === "AI Console <noreply@example.com>", msg.headers.get("from"));
  check("받는 이 머리", msg.headers.get("to") === "<alice@example.com>", msg.headers.get("to"));
  check("UTF-8 일반 글", msg.headers.get("content-type") === "text/plain; charset=UTF-8", msg.headers.get("content-type"));
  check("base64 로 싣는다", msg.headers.get("content-transfer-encoding") === "base64");
  check("MIME-Version", msg.headers.get("mime-version") === "1.0");
  check("Date 머리", /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/.test(msg.headers.get("date") ?? ""), msg.headers.get("date"));
  check("Message-ID 머리", /^<[^@\s]+@example\.com>$/.test(msg.headers.get("message-id") ?? ""), msg.headers.get("message-id"));
  check("본문이 원문으로 풀린다(줄바꿈은 CRLF)", msg.body === text.replace(/\n/g, "\r\n"), JSON.stringify(msg.body));
  check("모든 줄이 CRLF 로 끝나고 998자를 넘지 않는다", s.data.split("\r\n").every((l) => !l.includes("\n") && l.length <= 998));
  await fake.close();
}

{
  const fake = await startFake({ auth: "LOGIN" });
  await sendMail(configFor(fake.port, { user: "mailer", password: "pw" }), { to: "a@example.com", subject: "s", text: "t" });
  const cmds = fake.sessions[0].commands;
  check("PLAIN 이 없으면 LOGIN", cmds[1] === "AUTH LOGIN", cmds.join(" | "));
  check("  아이디와 비밀번호를 차례로", Buffer.from(cmds[2], "base64").toString() === "mailer" && Buffer.from(cmds[3], "base64").toString() === "pw");
  await fake.close();
}

{
  // STARTTLS 를 쓰라고 했는데 TLS 를 못 열었다면 비밀번호를 평문으로 보내지 않는다.
  const fake = await startFake({ auth: "PLAIN" });
  let error = "";
  try {
    await sendMail(configFor(fake.port, { secure: "starttls", user: "mailer", password: "pw" }), { to: "a@example.com", subject: "s", text: "t" });
  } catch (err) {
    error = (err as Error).message;
  }
  check("STARTTLS 가 없으면 평문 인증을 거절한다", error.includes("STARTTLS"), error);
  check("  AUTH 는 보내지 않았다", !fake.sessions[0].commands.some((c) => c.startsWith("AUTH")), fake.sessions[0].commands.join(" | "));
  check("  오류에 비밀번호가 없다", !error.includes("pw"), error);

  // 인증이 없으면 숨길 것이 없다 — 사내 중계 서버는 흔히 이렇다.
  await sendMail(configFor(fake.port, { secure: "starttls" }), { to: "a@example.com", subject: "s", text: "t" });
  check("인증 없이는 STARTTLS 가 없어도 보낸다", fake.sessions[1].commands.includes("DATA"), fake.sessions[1].commands.join(" | "));
  await fake.close();
}

{
  const fake = await startFake({ dropOnMail: true });
  let error = "";
  try {
    await sendMail(configFor(fake.port), { to: "a@example.com", subject: "s", text: "t" });
  } catch (err) {
    error = (err as Error).message;
  }
  check("서버가 끊으면 오류로 끝난다(멈추지 않는다)", error.length > 0, error);
  await fake.close();
}

{
  const fake = await startFake({ silent: true });
  const started = Date.now();
  let error = "";
  try {
    await sendMail(configFor(fake.port, { timeoutMs: 300 }), { to: "a@example.com", subject: "s", text: "t" });
  } catch (err) {
    error = (err as Error).message;
  }
  check("말이 없으면 시간 초과로 끝난다", error.includes("시간") && Date.now() - started < 2000, `${error} ${Date.now() - started}ms`);
  await fake.close();
}

{
  let error = "";
  try {
    await sendMail(configFor(1), { to: "a@example.com>\r\nRCPT TO:<x@y.z", subject: "s", text: "t" });
  } catch (err) {
    error = (err as Error).message;
  }
  check("주소에 줄바꿈이 끼면 보내지 않는다", error.includes("주소"), error);
}

/* ------------------------------------------------------- 게시판 답변 알림 */

console.log("server/routes/board.ts — 답변 메일");

const app = express();
app.use((req, _res, next) => {
  const who = String(req.headers["x-as"] ?? "alice");
  req.ownerId = who;
  req.user = { id: who, role: who === "admin" ? "admin" : "user" } as never;
  next();
});
app.use("/api", boardRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const appPort = (server.address() as AddressInfo).port;

async function call(as: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${appPort}/api${p}`, {
    method,
    headers: { "x-as": as, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

await createUser({ id: "alice", name: "앨리스", email: "alice@example.com", password: "alice-password-1", status: "active" });
await createUser({ id: "bob", name: "밥 관리자", email: "bob@example.com", password: "bob-password-1", status: "active" });
await createUser({ id: "carol", name: "캐럴", email: "", password: "carol-password-1", status: "active" });

const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(" "));
};

const fake = await startFake();
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = String(fake.port);
process.env.SMTP_SECURE = "none";
process.env.MAIL_FROM = "noreply@example.com";
process.env.APP_BASE_URL = "https://console.example.com/";

const post = (await call("alice", "POST", "/board", { title: "색인이 멈춥니다", body: "5MB pdf" })).json.post;
{
  const reply = await call("bob", "POST", `/board/${post.id}/replies`, { body: "확인했습니다.\n.env 의 값을 고쳐 보세요." });
  check("남이 답하면 답변은 그대로 올라간다", reply.status === 201, String(reply.status));
  check("글쓴이에게 메일이 간다", await waitFor(() => fake.sessions.some((s) => s.commands.includes("QUIT"))));
  await new Promise((r) => setTimeout(r, 200));
  check("  딱 한 통", fake.sessions.length === 1, String(fake.sessions.length));
  const s = fake.sessions[0];
  check("  받는 이는 글쓴이의 등록 주소", s.commands.includes("RCPT TO:<alice@example.com>"), s.commands.join(" | "));
  const msg = parseMessage(s.data);
  const subject = decodeWords(msg.headers.get("subject") ?? "");
  check("  제목에 번호와 글 제목", subject === `[AI Console 문의 게시판] #${post.number} 색인이 멈춥니다 에 답변이 달렸습니다`, subject);
  check("  본문에 답한 사람", msg.body.includes("밥 관리자 (@bob)"), msg.body);
  check("  본문에 답변 내용", msg.body.includes("확인했습니다.\r\n.env 의 값을 고쳐 보세요."), msg.body);
  check("  본문에 글 제목", msg.body.includes("색인이 멈춥니다"));
  check("  글로 가는 주소(끝의 / 는 하나로)", msg.body.includes(`https://console.example.com/#/board/${post.id}`), msg.body);
}

{
  const before = fake.sessions.length;
  const own = await call("alice", "POST", `/board/${post.id}/replies`, { body: "고맙습니다" });
  await new Promise((r) => setTimeout(r, 300));
  check("자기 글에 자기가 답하면 보내지 않는다", own.status === 201 && fake.sessions.length === before, String(fake.sessions.length - before));
}

{
  const noMail = (await call("carol", "POST", "/board", { title: "주소 없는 사람" })).json.post;
  const before = fake.sessions.length;
  const res = await call("bob", "POST", `/board/${noMail.id}/replies`, { body: "답" });
  await new Promise((r) => setTimeout(r, 300));
  check("글쓴이 주소가 없으면 보내지 않는다", res.status === 201 && fake.sessions.length === before, String(fake.sessions.length - before));
}

{
  const before = fake.sessions.length;
  const long = "가".repeat(5000);
  await call("bob", "POST", `/board/${post.id}/replies`, { body: long });
  await waitFor(() => fake.sessions.length > before && fake.sessions.at(-1)!.commands.includes("QUIT"));
  const body = parseMessage(fake.sessions.at(-1)!.data).body;
  check("긴 답변은 4,000자에서 자르고 알린다", body.includes("가".repeat(4000)) && !body.includes("가".repeat(4001)) && body.includes("…"), String(body.length));
}

{
  delete process.env.APP_BASE_URL;
  process.env.SHARE_BASE_URL = "http://share.example.com:9000";
  const before = fake.sessions.length;
  await call("bob", "POST", `/board/${post.id}/replies`, { body: "주소 확인" });
  await waitFor(() => fake.sessions.length > before && fake.sessions.at(-1)!.commands.includes("QUIT"));
  const body = parseMessage(fake.sessions.at(-1)!.data).body;
  check("APP_BASE_URL 이 없으면 SHARE_BASE_URL", body.includes(`http://share.example.com:9000/#/board/${post.id}`), body);

  delete process.env.SHARE_BASE_URL;
  const next = fake.sessions.length;
  await call("bob", "POST", `/board/${post.id}/replies`, { body: "주소 없음" });
  await waitFor(() => fake.sessions.length > next && fake.sessions.at(-1)!.commands.includes("QUIT"));
  const bare = parseMessage(fake.sessions.at(-1)!.data).body;
  check("둘 다 없으면 주소 줄을 뺀다", bare.length > 0 && !bare.includes("#/board/"), bare);
}

{
  delete process.env.SMTP_HOST;
  const before = fake.sessions.length;
  const res = await call("bob", "POST", `/board/${post.id}/replies`, { body: "메일 꺼짐" });
  await new Promise((r) => setTimeout(r, 300));
  check("메일이 꺼져 있으면 보내지 않는다", res.status === 201 && fake.sessions.length === before, String(fake.sessions.length - before));
}

{
  const broken = await startFake({ dropOnMail: true });
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(broken.port);
  process.env.SMTP_USER = "";
  process.env.SMTP_PASSWORD = "do-not-log-me";
  warnings.length = 0;
  const res = await call("bob", "POST", `/board/${post.id}/replies`, { body: "서버가 끊어도" });
  check("메일 서버가 끊어도 답변은 201", res.status === 201, String(res.status));
  check("  경고 한 줄을 남긴다", await waitFor(() => warnings.some((w) => w.includes("[mail]"))), warnings.join(" / "));
  const line = warnings.find((w) => w.includes("[mail]")) ?? "";
  check("  경고에 이유가 있고 비밀번호는 없다", line.length > 0 && !line.includes("do-not-log-me") && !line.includes("\n"), line);
  await broken.close();
}

console.warn = originalWarn;
server.close();
await fake.close();
await fs.rm(dataDir, { recursive: true, force: true });

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
