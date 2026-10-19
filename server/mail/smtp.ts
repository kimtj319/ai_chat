/**
 * 메일 한 통을 SMTP 로 보낸다.
 *
 * 의존성을 들이지 않고 node:net·node:tls 로 직접 말한다. 운영 배포는 dist/ 와
 * dist-server/ 만 컨테이너에 넣고 node_modules 는 이미지에 고정돼 있어서, 새 npm
 * 패키지는 배포에 실리지 않는다. 우리가 쓰는 것은 "글 한 통을 한 사람에게" 뿐이라
 * 규약에서 필요한 부분이 크지 않다: EHLO, (STARTTLS), AUTH, MAIL/RCPT/DATA, QUIT.
 *
 * 설정은 보낼 때마다 환경에서 읽는다(mailConfigFromEnv). 값이 하나라도 빠지면
 * null — 메일 기능이 꺼진 것이고, 부르는 쪽은 조용히 건너뛴다.
 */
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";

export type SmtpSecure = "starttls" | "ssl" | "none";

export interface MailConfig {
  host: string;
  port: number;
  /** starttls: 서버가 내놓으면 TLS 로 올린다. ssl: 처음부터 TLS(465). none: TLS 를 쓰지 않는다. */
  secure: SmtpSecure;
  user?: string;
  password?: string;
  from: string;
  fromName: string;
  /** 사설 CA 를 쓰는 사내 메일 서버라면 false 로 둔다. */
  rejectUnauthorized: boolean;
  timeoutMs: number;
}

export interface MailInput {
  to: string;
  subject: string;
  text: string;
}

const TIMEOUT_MS = 15_000;
/**
 * 모양만 본다. 줄바꿈·꺾쇠·공백이 끼면 봉투(MAIL FROM:<…>)나 머리 줄을 깨뜨려
 * 남의 명령이나 머리를 끼워 넣을 수 있으므로, 그런 글자는 아예 받지 않는다.
 */
const ADDRESS_PATTERN = /^[^\s<>()",;:\\[\]@]+@[^\s<>()",;:\\[\]@]+\.[^\s<>()",;:\\[\]@]+$/;

export function isMailAddress(raw: string): boolean {
  return raw.length <= 254 && ADDRESS_PATTERN.test(raw);
}

/** 운영자가 적은 값. SMTP_HOST 와 MAIL_FROM 이 둘 다 있어야 켜진다. */
export function mailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MailConfig | null {
  const host = env.SMTP_HOST?.trim();
  const from = env.MAIL_FROM?.trim();
  if (!host || !from || !isMailAddress(from)) return null;
  const rawSecure = env.SMTP_SECURE?.trim().toLowerCase();
  const secure: SmtpSecure = rawSecure === "ssl" || rawSecure === "none" ? rawSecure : "starttls";
  const port = Number.parseInt(env.SMTP_PORT ?? "", 10);
  return {
    host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : secure === "ssl" ? 465 : 587,
    secure,
    user: env.SMTP_USER?.trim() || undefined,
    password: env.SMTP_PASSWORD ?? "",
    from,
    fromName: env.MAIL_FROM_NAME?.trim() || "AI Console",
    rejectUnauthorized: !/^(0|false|no|off)$/i.test(env.SMTP_TLS_REJECT_UNAUTHORIZED?.trim() ?? ""),
    timeoutMs: TIMEOUT_MS,
  };
}

/** 기동 때 한 줄. 비밀번호는 있다 없다만 말한다. */
export function describeMailConfig(cfg: MailConfig | null): string {
  if (!cfg) return "꺼짐 (SMTP_HOST·MAIL_FROM 이 없어 답변 알림 메일을 보내지 않습니다)";
  const auth = cfg.user ? `인증 ${cfg.user}` : "인증 없음";
  return `${cfg.host}:${cfg.port} (${cfg.secure}, ${auth}) 보내는 이 ${cfg.from}`;
}

/**
 * RFC 2047 encoded-word. 머리에는 ASCII 만 들어갈 수 있으므로 한국어 제목·이름은
 * UTF-8 을 base64 로 싸서 넣는다. 낱말 하나가 75자를 넘으면 안 되므로 글자 단위로
 * 잘라 여러 낱말로 나눈다 — 바이트로 자르면 한 글자가 두 낱말에 걸쳐 깨진다.
 * 줄바꿈은 먼저 공백으로 바꾼다: 머리에 끼면 그 뒤가 새 머리가 된다.
 */
export function encodeWord(raw: string): string {
  const text = raw.replace(/[\r\n]+/g, " ");
  if (/^[\x20-\x7e]*$/.test(text) && !text.includes("=?")) return text;
  const chunks: string[] = [];
  let chunk = "";
  for (const ch of text) {
    // 42바이트 → base64 56자 + 앞뒤 12자 = 68자. "Subject: " 를 붙여도 한 줄이 78자 안이다.
    if (Buffer.byteLength(chunk + ch) > 42) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** RFC 5322 날짜. toUTCString 의 "GMT" 는 옛 표기라 숫자 시간대로 바꾼다. */
function mailDate(now: Date): string {
  return now.toUTCString().replace(/GMT$/, "+0000");
}

/**
 * 보낼 메시지 전체. 본문은 base64 로 싣는다 — 한국어가 대부분이라 quoted-printable
 * 보다 짧고, 8bit 를 못 받는 중계 서버를 지나도 깨지지 않는다. 일반 글의 줄바꿈은
 * 규약상 CRLF 이므로 LF 를 CRLF 로 맞춘 뒤에 싼다.
 */
export function buildMessage(cfg: MailConfig, mail: MailInput, now = new Date()): string {
  const domain = cfg.from.split("@")[1];
  const body = Buffer.from(mail.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64");
  const lines = [
    `From: ${encodeWord(cfg.fromName)} <${cfg.from}>`,
    `To: <${mail.to}>`,
    `Subject: ${encodeWord(mail.subject)}`,
    `Date: ${mailDate(now)}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    ...(body.match(/.{1,76}/g) ?? []),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

export async function sendMail(cfg: MailConfig, mail: MailInput): Promise<void> {
  if (!isMailAddress(mail.to)) throw new Error("받는 주소가 올바르지 않습니다");
  await deliver(cfg, mail.to, buildMessage(cfg, mail));
}

interface Reply {
  code: number;
  lines: string[];
}

/**
 * 소켓에서 응답을 하나씩 꺼낸다. 응답은 여러 줄일 수 있다("250-..." 이 이어지다
 * "250 ..." 에서 끝난다). 끊기거나 오류가 나면 기다리던 쪽에 그대로 전한다 —
 * 그러지 않으면 서버가 말없이 끊었을 때 영영 기다린다.
 */
function replyReader(socket: net.Socket) {
  let buf = "";
  let current: string[] = [];
  const ready: Reply[] = [];
  let waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  let failure: Error | null = null;

  const onData = (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      current.push(line);
      if (/^\d{3}-/.test(line)) continue;
      const reply = { code: Number.parseInt(line.slice(0, 3), 10) || 0, lines: current.map((l) => l.slice(4)) };
      current = [];
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.resolve(reply);
      } else ready.push(reply);
    }
  };
  const fail = (err: Error) => {
    failure ??= err;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.reject(failure);
    }
  };
  const onError = (err: Error) => fail(err);
  const onClose = () => fail(new Error("메일 서버가 연결을 닫았습니다"));
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);

  return {
    next(): Promise<Reply> {
      const r = ready.shift();
      if (r) return Promise.resolve(r);
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
      });
    },
    /** STARTTLS 로 소켓을 넘겨줄 때. 평문 소켓의 이벤트를 더는 듣지 않는다. */
    detach() {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    },
  };
}

/** 줄 맨 앞의 점에 점을 하나 더 붙인다. 점 하나뿐인 줄은 DATA 의 끝이라는 뜻이기 때문이다. */
function dotStuff(message: string): string {
  return message.replace(/\r?\n/g, "\r\n").replace(/(^|\r\n)\./g, "$1..");
}

function ehloName(): string {
  const name = os.hostname();
  return /^[A-Za-z0-9.-]+$/.test(name) ? name : "localhost";
}

function connect(cfg: MailConfig): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket =
      cfg.secure === "ssl"
        ? tls.connect({ host: cfg.host, port: cfg.port, servername: net.isIP(cfg.host) ? undefined : cfg.host, rejectUnauthorized: cfg.rejectUnauthorized })
        : net.connect({ host: cfg.host, port: cfg.port });
    // 연결부터 마지막 응답까지 쉬는 시간이 이만큼 넘으면 끊는다. 메일은 뒤에서
    // 보내므로 아무도 기다리지 않지만, 매달린 소켓이 쌓이면 안 된다.
    socket.setTimeout(cfg.timeoutMs, () => socket.destroy(new Error(`메일 서버가 ${cfg.timeoutMs / 1000}초 동안 응답하지 않아 시간 초과`)));
    const ok = () => {
      socket.off("error", bad);
      resolve(socket);
    };
    const bad = (err: Error) => reject(err);
    socket.once(cfg.secure === "ssl" ? "secureConnect" : "connect", ok);
    socket.once("error", bad);
  });
}

function upgrade(cfg: MailConfig, plain: net.Socket): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({
      socket: plain,
      servername: net.isIP(cfg.host) ? undefined : cfg.host,
      rejectUnauthorized: cfg.rejectUnauthorized,
    });
    secured.setTimeout(cfg.timeoutMs, () => secured.destroy(new Error(`메일 서버가 ${cfg.timeoutMs / 1000}초 동안 응답하지 않아 시간 초과`)));
    secured.once("secureConnect", () => {
      secured.off("error", reject);
      resolve(secured);
    });
    secured.once("error", reject);
  });
}

/** EHLO 응답에서 확장 이름들을 대문자로. "AUTH=LOGIN" 같은 옛 표기도 AUTH 로 읽는다. */
function extensions(reply: Reply): Map<string, string> {
  const ext = new Map<string, string>();
  for (const line of reply.lines.slice(1)) {
    const [name, ...rest] = line.trim().split(/[\s=]+/);
    if (name) ext.set(name.toUpperCase(), `${ext.get(name.toUpperCase()) ?? ""} ${rest.join(" ").toUpperCase()}`.trim());
  }
  return ext;
}

/**
 * 이미 만든 메시지를 한 사람에게 보낸다. 응답 코드가 기대와 다르면 그 단계와
 * 서버가 한 말을 담아 던진다. 서버의 말에는 우리가 보낸 비밀번호가 들어가지
 * 않으므로 그대로 기록해도 된다.
 */
export async function deliver(cfg: MailConfig, to: string, message: string): Promise<void> {
  if (!isMailAddress(to) || !isMailAddress(cfg.from)) throw new Error("메일 주소가 올바르지 않습니다");
  let socket = await connect(cfg);
  let reader = replyReader(socket);
  const expect = async (stage: string, ...codes: number[]): Promise<Reply> => {
    const reply = await reader.next();
    if (!codes.includes(reply.code)) {
      throw new Error(`${stage} 단계에서 거절: ${reply.code} ${reply.lines.join(" ").slice(0, 200)}`);
    }
    return reply;
  };
  const say = (line: string) => socket.write(`${line}\r\n`);

  try {
    await expect("인사", 220);
    say(`EHLO ${ehloName()}`);
    let ext = extensions(await expect("EHLO", 250));
    let secured = cfg.secure === "ssl";

    if (cfg.secure === "starttls" && ext.has("STARTTLS")) {
      say("STARTTLS");
      await expect("STARTTLS", 220);
      reader.detach();
      socket = await upgrade(cfg, socket);
      reader = replyReader(socket);
      secured = true;
      // TLS 뒤에는 처음부터 다시 인사한다 — 앞에서 들은 확장 목록은 믿지 않는다.
      say(`EHLO ${ehloName()}`);
      ext = extensions(await expect("EHLO", 250));
    }

    if (cfg.user) {
      // STARTTLS 를 쓰라고 했는데 서버가 내놓지 않았다면, 비밀번호를 평문으로
      // 흘리느니 보내지 않는다. 평문이 의도라면 SMTP_SECURE=none 으로 밝힌다.
      if (!secured && cfg.secure === "starttls") {
        throw new Error("메일 서버가 STARTTLS 를 내놓지 않아 비밀번호를 평문으로 보내지 않았습니다 (의도라면 SMTP_SECURE=none)");
      }
      const methods = ext.get("AUTH")?.split(" ") ?? [];
      const password = cfg.password ?? "";
      if (methods.includes("LOGIN") && !methods.includes("PLAIN")) {
        say("AUTH LOGIN");
        await expect("AUTH LOGIN", 334);
        say(Buffer.from(cfg.user, "utf8").toString("base64"));
        await expect("AUTH LOGIN 아이디", 334);
        say(Buffer.from(password, "utf8").toString("base64"));
        await expect("AUTH LOGIN 비밀번호", 235);
      } else {
        // PLAIN 을 내놓았거나 아무것도 말하지 않았다. 말하지 않은 서버에도 가장
        // 흔한 PLAIN 을 먼저 시도해 본다 — 안 되면 서버가 거절을 말해 준다.
        say(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${password}`, "utf8").toString("base64")}`);
        await expect("AUTH PLAIN", 235);
      }
    }

    say(`MAIL FROM:<${cfg.from}>`);
    await expect("MAIL FROM", 250);
    say(`RCPT TO:<${to}>`);
    await expect("RCPT TO", 250, 251);
    say("DATA");
    await expect("DATA", 354);
    const stuffed = dotStuff(message);
    socket.write(`${stuffed}${stuffed.endsWith("\r\n") ? "" : "\r\n"}.\r\n`);
    await expect("메시지 본문", 250);
    say("QUIT");
    // 이미 받았다고 했다. QUIT 응답이 오지 않아도 메일은 나갔다.
    await reader.next().catch(() => undefined);
  } finally {
    reader.detach();
    // 듣는 이를 뗀 소켓에 늦은 오류가 오면 프로세스가 죽는다. 버릴 소켓이라 삼킨다.
    socket.on("error", () => {});
    socket.destroy();
  }
}
