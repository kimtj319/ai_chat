import type { ToolDefinition } from "./types.js";

interface Rgb {
  r: number;
  g: number;
  b: number;
}
interface Hsl {
  h: number;
  s: number;
  l: number;
}

function parseHex(input: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  let hex = m[1]!;
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function parseRgb(input: string): Rgb | null {
  const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i.exec(input.trim());
  if (!m) return null;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if ([r, g, b].some((v) => v > 255)) return null;
  return { r, g, b };
}

function parseHsl(input: string): Hsl | null {
  const m = /^hsla?\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%\s*(?:,\s*[\d.]+\s*)?\)$/i.exec(input.trim());
  if (!m) return null;
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export const colorConvertTool: ToolDefinition = {
  name: "color_convert",
  description:
    'Convert a color between hex, rgb(), and hsl() notation. Accepts any one of the three formats as input ' +
    '(e.g. "#3498db", "rgb(52, 152, 219)", "hsl(204, 70%, 53%)") and returns all three representations.',
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      color: { type: "string", description: 'Color in hex, rgb(), or hsl() form, e.g. "#ff0000" or "rgb(255,0,0)".' },
    },
    required: ["color"],
    additionalProperties: false,
  },
  async execute(args: { color: string }) {
    const input = typeof args?.color === "string" ? args.color.trim() : "";
    if (!input) throw new Error("color must be a non-empty string");

    let rgb = parseHex(input) ?? parseRgb(input);
    if (!rgb) {
      const hsl = parseHsl(input);
      if (hsl) rgb = hslToRgb(hsl);
    }
    if (!rgb) {
      throw new Error(
        `Could not parse color "${input}" — use hex ("#rrggbb"), rgb ("rgb(r,g,b)"), or hsl ("hsl(h,s%,l%)").`,
      );
    }

    const hsl = rgbToHsl(rgb);
    return {
      input,
      hex: toHex(rgb),
      rgb: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
      hsl: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`,
    };
  },
};
