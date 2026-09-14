import type { ToolDefinition } from "./types.js";
import { evaluateExpression } from "./safeMath.js";

export const calculatorTool: ToolDefinition = {
  name: "calculator",
  description:
    "Evaluate an arithmetic expression. Supports + - * / % ^ (power), parentheses, and common Math functions " +
    "(sin, cos, tan, asin, acos, atan, sqrt, abs, exp, log, log10, log2, floor, ceil, round, min, max, pow) " +
    "plus the constants pi and e. Does not execute arbitrary code.",
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: 'Arithmetic expression to evaluate, e.g. "(3 + 4) * 2^10" or "sqrt(2) * pi"',
      },
    },
    required: ["expression"],
    additionalProperties: false,
  },
  async execute(args: { expression: string }) {
    const result = evaluateExpression(args?.expression);
    return { expression: args.expression, result };
  },
};
