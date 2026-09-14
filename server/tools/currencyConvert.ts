import type { ToolDefinition } from "./types.js";
import { config } from "../config.js";

const ENDPOINT = "https://api.frankfurter.dev/v1/latest";

export const currencyConvertTool: ToolDefinition = {
  name: "currency_convert",
  description:
    "Convert an amount between currencies using the latest daily European Central Bank reference rates (via " +
    "frankfurter.dev, keyless). Use ISO 4217 codes (USD, EUR, KRW, JPY, GBP, ...). Rates update once per weekday " +
    "and are not real-time market/trading rates — say so if the user needs live FX.",
  category: "data",
  parameters: {
    type: "object",
    properties: {
      amount: { type: "number", description: "Amount to convert. Defaults to 1." },
      from: { type: "string", description: 'Source currency ISO 4217 code, e.g. "USD".' },
      to: { type: "string", description: 'Target currency ISO 4217 code, e.g. "KRW".' },
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  async execute(args: { amount?: number; from: string; to: string }) {
    const from = typeof args?.from === "string" ? args.from.trim().toUpperCase() : "";
    const to = typeof args?.to === "string" ? args.to.trim().toUpperCase() : "";
    if (!/^[A-Z]{3}$/.test(from)) throw new Error(`from must be a 3-letter currency code, got "${args?.from}"`);
    if (!/^[A-Z]{3}$/.test(to)) throw new Error(`to must be a 3-letter currency code, got "${args?.to}"`);
    const amount = typeof args?.amount === "number" && Number.isFinite(args.amount) ? args.amount : 1;

    const url = new URL(ENDPOINT);
    url.searchParams.set("amount", String(amount));
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(config.toolHttpTimeoutMs) });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`Currency conversion timed out after ${config.toolHttpTimeoutMs / 1000}s`);
      }
      throw new Error(`Currency conversion request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 404) {
      throw new Error(`Unknown currency code: "${from}" or "${to}" is not a supported ISO 4217 code.`);
    }
    if (!res.ok) throw new Error(`Currency conversion service responded ${res.status}`);

    const data = (await res.json()) as { amount: number; base: string; date: string; rates: Record<string, number> };
    const result = data.rates[to];
    if (result === undefined) throw new Error(`No rate available for "${to}"`);

    return {
      amount,
      from,
      to,
      result,
      rate: amount !== 0 ? result / amount : null,
      asOf: data.date,
      source: "European Central Bank reference rates (via frankfurter.dev)",
    };
  },
};
