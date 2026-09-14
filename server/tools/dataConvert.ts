import type { ToolDefinition } from "./types.js";

const MAX_INPUT_CHARS = 100_000;

// Hand-written CSV parser/serializer (RFC 4180-ish: double-quote escaping,
// quoted fields may contain commas/newlines) — no library allowed.

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

function csvField(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvToJson(input: string): unknown[] {
  const rows = parseCsv(input);
  if (rows.length === 0) return [];
  const [header, ...dataRows] = rows;
  return dataRows.map((row) => {
    const obj: Record<string, string> = {};
    header!.forEach((key, idx) => {
      obj[key || `column${idx + 1}`] = row[idx] ?? "";
    });
    return obj;
  });
}

function jsonToCsv(value: unknown): string {
  if (!Array.isArray(value)) {
    throw new Error("JSON must be an array of flat objects to convert to CSV");
  }
  if (value.length === 0) return "";
  const columns = new Set<string>();
  for (const row of value) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("Every array element must be a flat JSON object (no nested arrays/objects) to convert to CSV");
    }
    for (const key of Object.keys(row as Record<string, unknown>)) columns.add(key);
  }
  const header = [...columns];
  const lines = [header.map(csvField).join(",")];
  for (const row of value as Record<string, unknown>[]) {
    lines.push(header.map((col) => csvField(row[col])).join(","));
  }
  return lines.join("\n");
}

export const dataConvertTool: ToolDefinition = {
  name: "data_convert",
  description:
    'Convert data between JSON and CSV, or pretty-print/minify JSON. Give `data` as a string, and set `from`/`to` ' +
    'to "json" or "csv". JSON->CSV requires the JSON to be an array of flat objects; CSV->JSON uses the first ' +
    "row as column headers.",
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      data: { type: "string", description: "The input data as a string." },
      from: { type: "string", enum: ["json", "csv"], description: "Format of the input data." },
      to: { type: "string", enum: ["json", "csv"], description: "Desired output format." },
      pretty: {
        type: "boolean",
        description: "When output is JSON, pretty-print with 2-space indent (default true).",
      },
    },
    required: ["data", "from", "to"],
    additionalProperties: false,
  },
  async execute(args: { data: string; from: "json" | "csv"; to: "json" | "csv"; pretty?: boolean }) {
    if (typeof args?.data !== "string" || args.data.length === 0) {
      throw new Error("data must be a non-empty string");
    }
    if (args.data.length > MAX_INPUT_CHARS) {
      throw new Error(`data too large (${args.data.length} chars, limit ${MAX_INPUT_CHARS})`);
    }
    if (args.from !== "json" && args.from !== "csv") throw new Error('from must be "json" or "csv"');
    if (args.to !== "json" && args.to !== "csv") throw new Error('to must be "json" or "csv"');

    let parsed: unknown;
    if (args.from === "json") {
      try {
        parsed = JSON.parse(args.data);
      } catch (err) {
        throw new Error(`Input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      parsed = csvToJson(args.data);
    }

    if (args.to === "csv") {
      return { output: jsonToCsv(parsed), format: "csv" };
    }
    const pretty = args.pretty !== false;
    return { output: JSON.stringify(parsed, null, pretty ? 2 : 0), format: "json" };
  },
};
