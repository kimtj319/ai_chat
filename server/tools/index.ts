import type { ToolDefinition } from "./types.js";
import { calculatorTool } from "./calculator.js";
import { getCurrentTimeTool } from "./time.js";
import { httpFetchTool } from "./httpFetch.js";
import { webSearchTool } from "./webSearch.js";
import { readTextFileTool } from "./readTextFile.js";
import { listDirectoryTool } from "./listDirectory.js";
import { weatherLookupTool } from "./weatherLookup.js";
import { wikipediaLookupTool } from "./wikipediaLookup.js";
import { currencyConvertTool } from "./currencyConvert.js";
import { unitConvertTool } from "./unitConvert.js";
import { datetimeCalcTool } from "./datetimeCalc.js";
import { articleExtractTool } from "./articleExtract.js";
import { textStatsTool } from "./textStats.js";
import { dataConvertTool } from "./dataConvert.js";
import { encodeDecodeTool } from "./encodeDecode.js";
import { hashTextTool } from "./hashText.js";
import { generateRandomTool } from "./generateRandom.js";
import { colorConvertTool } from "./colorConvert.js";
import { diffTextTool } from "./diffText.js";
import { regexTestTool } from "./regexTest.js";
import { jsonQueryTool } from "./jsonQuery.js";
import { sortUniqueTool } from "./sortUnique.js";
import { unicodeInspectTool } from "./unicodeInspect.js";
import { cidrCalcTool } from "./cidrCalc.js";
import { cronDescribeTool } from "./cronDescribe.js";
import { urlParseTool } from "./urlParse.js";
import { readAttachmentTool } from "./readAttachment.js";

// Registering a new tool = write a file exporting a ToolDefinition, then add it here.
// See README.md "Adding a tool" for the full walkthrough.
const ALL_TOOLS: ToolDefinition[] = [
  calculatorTool,
  getCurrentTimeTool,
  webSearchTool,
  httpFetchTool,
  readTextFileTool,
  listDirectoryTool,
  weatherLookupTool,
  wikipediaLookupTool,
  currencyConvertTool,
  unitConvertTool,
  datetimeCalcTool,
  articleExtractTool,
  textStatsTool,
  dataConvertTool,
  encodeDecodeTool,
  hashTextTool,
  generateRandomTool,
  colorConvertTool,
  diffTextTool,
  regexTestTool,
  jsonQueryTool,
  sortUniqueTool,
  unicodeInspectTool,
  cidrCalcTool,
  cronDescribeTool,
  urlParseTool,
];

/**
 * Offered only to a conversation that actually holds a non-inlined text
 * attachment (chat/toolLoop.ts), so it is resolvable by name but deliberately
 * absent from listTools(): it must not appear in the tool toggles, and
 * createConversation must not enable it by default, because in a conversation
 * with no attachments it is a schema the model can only misuse.
 */
const CONTEXTUAL_TOOLS: ToolDefinition[] = [readAttachmentTool];

/**
 * "mcp__" is reserved for tools discovered from an MCP server, whose names are
 * `mcp__{slug}__{tool}` (mcp/toolAdapter.ts). A builtin taking that prefix
 * would be indistinguishable from a remote tool in the per-turn lookup, and the
 * model would reach one when it asked for the other — so this refuses to start
 * rather than shadowing anything. It throws at import time because a name
 * collision is a coding mistake, not a runtime condition: it must be impossible
 * to deploy, not merely logged.
 */
for (const tool of [...ALL_TOOLS, ...CONTEXTUAL_TOOLS]) {
  if (tool.name.startsWith("mcp__")) {
    throw new Error(`Builtin tool "${tool.name}" uses the reserved "mcp__" prefix, which belongs to MCP tools.`);
  }
}

const registry = new Map([...ALL_TOOLS, ...CONTEXTUAL_TOOLS].map((t) => [t.name, t]));

export function listTools(): ToolDefinition[] {
  return ALL_TOOLS;
}

export { readAttachmentTool };

export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name);
}
