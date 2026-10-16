import type { ToolDefinition } from "./types.js";

/**
 * 사용자 자신의 크롬을 조작하는 도구들. 서버에서 실행되지 않는다 — 호출은 웹페이지를
 * 거쳐 사용자가 설치한 확장 프로그램(extension/)으로 가고, 결과가 같은 길로 돌아온다
 * (chat/browserBridge.ts, chat/toolLoop.ts).
 *
 * 대화의 도구 목록(enabledTools)에 들지 않는다. 그 턴을 보낸 브라우저에 확장 프로그램이
 * 연결돼 있고 사용자가 입력창에서 "크롬 제어" 를 켰을 때만 그 턴에 실린다 — 확장이 없는
 * 브라우저에서 보낸 턴에 실리면 모델은 아무도 받지 않는 명령을 보내게 된다.
 */

const tabId = {
  type: "integer",
  description: "Which tab to act on. Omit to use the tab of the most recent browser action.",
};

function relayed(): never {
  // toolLoop 이 이름으로 가로채므로 여기까지 오지 않는다.
  throw new Error("browser tools are executed by the user's Chrome extension, not by the server");
}

export const BROWSER_TOOLS: ToolDefinition[] = [
  {
    name: "browser_open",
    category: "browser",
    description:
      "Open a web page in the USER'S OWN Chrome browser (through the AI Console Chrome extension) and return the page as text: " +
      "title, address, visible text, and a numbered list of elements you can act on, like [e12]. " +
      "The user is signed in to their own accounts there, so do only what the user asked for. " +
      "Opens a background tab unless new_tab is false. The first visit to a site asks the user for permission; " +
      "if they refuse you get an error — do not try that site again.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full address, e.g. https://www.example.com/path" },
        new_tab: { type: "boolean", description: "false reuses the tab of the most recent browser action. Default true." },
      },
      required: ["url"],
    },
    execute: relayed,
  },
  {
    name: "browser_read",
    category: "browser",
    description:
      "Read a tab of the user's Chrome again: title, address, visible text and the numbered elements ([e12]) to act on. " +
      "Element refs from an earlier read stop being valid once the page changes, so read again before acting on a changed page. " +
      "Long pages return the text in parts; pass text_offset to continue.",
    parameters: {
      type: "object",
      properties: {
        tab_id: tabId,
        text_offset: { type: "integer", description: "Character offset to continue reading the page text from." },
      },
    },
    execute: relayed,
  },
  {
    name: "browser_click",
    category: "browser",
    description:
      "Click an element of the page by its ref (e.g. \"e12\") from the latest browser_read/browser_open result, and return the page afterwards. " +
      "Clicks that look like submitting, sending, buying, deleting or confirming need the user's approval, which they give in AI Console; " +
      "if they decline you get an error — do not retry the same click.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref such as e12." },
        tab_id: tabId,
      },
      required: ["ref"],
    },
    execute: relayed,
  },
  {
    name: "browser_type",
    category: "browser",
    description:
      "Type text into an input box, text area or editable area by ref, or pick an option of a select list by its visible text. " +
      "submit=true then presses Enter / submits the form (use it for searches). " +
      "Password fields are refused — ask the user to type passwords themselves.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref such as e5." },
        text: { type: "string", description: "Text to enter, or the option to choose in a select list." },
        submit: { type: "boolean", description: "Press Enter / submit after typing. Default false." },
        tab_id: tabId,
      },
      required: ["ref", "text"],
    },
    execute: relayed,
  },
  {
    name: "browser_scroll",
    category: "browser",
    description: "Scroll the page and return it again. Use it to reach content and elements marked (화면 밖) or further down the page.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["down", "up", "top", "bottom"], description: "Default down." },
        tab_id: tabId,
      },
    },
    execute: relayed,
  },
  {
    name: "browser_back",
    category: "browser",
    description: "Go back to the previous page in the tab, like the browser's back button, and return that page.",
    parameters: { type: "object", properties: { tab_id: tabId } },
    execute: relayed,
  },
  {
    name: "browser_tabs",
    category: "browser",
    description: "List the user's open Chrome tabs on sites they have allowed, with their tab ids. Tabs on other sites are not shown.",
    parameters: { type: "object", properties: {} },
    execute: relayed,
  },
];

const BROWSER_TOOL_NAMES = new Set(BROWSER_TOOLS.map((t) => t.name));

export function isBrowserTool(name: string): boolean {
  return BROWSER_TOOL_NAMES.has(name);
}
