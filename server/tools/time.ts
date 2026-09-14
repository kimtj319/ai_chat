import type { ToolDefinition } from "./types.js";

export const getCurrentTimeTool: ToolDefinition = {
  name: "get_current_time",
  description:
    'Get the current date and time, optionally converted to a specific IANA timezone (e.g. "Asia/Seoul", ' +
    '"America/New_York"). Returns an ISO 8601 UTC timestamp plus a human-readable string in the requested zone.',
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA timezone name, e.g. Asia/Seoul. Defaults to UTC if omitted.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(args: { timezone?: string }) {
    const now = new Date();
    const timezone = args?.timezone?.trim();
    let human: string;
    if (timezone) {
      try {
        human = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          dateStyle: "full",
          timeStyle: "long",
        }).format(now);
      } catch {
        throw new Error(`Unknown or invalid IANA timezone: "${timezone}"`);
      }
    } else {
      human = now.toUTCString();
    }
    return {
      iso: now.toISOString(),
      timezone: timezone || "UTC",
      human,
      epochMs: now.getTime(),
    };
  },
};
