import type { ToolDefinition } from "./types.js";

// Conversion factor to each category's base unit. Temperature is handled
// separately since it needs an affine (not purely linear) formula.
const LENGTH: Record<string, number> = {
  m: 1, meter: 1, meters: 1, metre: 1, metres: 1,
  km: 1000, kilometer: 1000, kilometre: 1000,
  cm: 0.01, centimeter: 0.01,
  mm: 0.001, millimeter: 0.001,
  mile: 1609.344, miles: 1609.344, mi: 1609.344,
  yard: 0.9144, yards: 0.9144, yd: 0.9144,
  foot: 0.3048, feet: 0.3048, ft: 0.3048,
  inch: 0.0254, inches: 0.0254, in: 0.0254,
  nauticalmile: 1852, nmi: 1852,
};
const MASS: Record<string, number> = {
  kg: 1, kilogram: 1, kilograms: 1,
  g: 0.001, gram: 0.001, grams: 0.001,
  mg: 0.000001, milligram: 0.000001,
  lb: 0.45359237, lbs: 0.45359237, pound: 0.45359237, pounds: 0.45359237,
  oz: 0.028349523125, ounce: 0.028349523125, ounces: 0.028349523125,
  tonne: 1000, tonnes: 1000, t: 1000,
  stone: 6.35029318, st: 6.35029318,
};
const VOLUME: Record<string, number> = {
  l: 1, liter: 1, liters: 1, litre: 1, litres: 1,
  ml: 0.001, milliliter: 0.001,
  m3: 1000, cubicmeter: 1000,
  gal: 3.785411784, gallon: 3.785411784, gallons: 3.785411784,
  qt: 0.946352946, quart: 0.946352946, quarts: 0.946352946,
  pt: 0.473176473, pint: 0.473176473, pints: 0.473176473,
  cup: 0.2365882365, cups: 0.2365882365,
  floz: 0.0295735295625, fluidounce: 0.0295735295625,
};
const SPEED: Record<string, number> = {
  mps: 1, "m/s": 1,
  kmh: 0.2777777778, "km/h": 0.2777777778, kph: 0.2777777778,
  mph: 0.44704,
  knot: 0.5144444444, knots: 0.5144444444, kn: 0.5144444444,
};
const AREA: Record<string, number> = {
  m2: 1, sqm: 1,
  km2: 1_000_000, sqkm: 1_000_000,
  hectare: 10_000, hectares: 10_000, ha: 10_000,
  acre: 4046.8564224, acres: 4046.8564224,
  ft2: 0.09290304, sqft: 0.09290304,
  mi2: 2_589_988.110336, sqmi: 2_589_988.110336,
};
const DIGITAL: Record<string, number> = {
  bit: 0.125, bits: 0.125,
  byte: 1, bytes: 1, b: 1,
  kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
};

const CATEGORIES: Record<string, Record<string, number>> = {
  length: LENGTH,
  mass: MASS,
  volume: VOLUME,
  speed: SPEED,
  area: AREA,
  "digital storage": DIGITAL,
};

const TEMPERATURE_UNITS = new Set(["c", "celsius", "f", "fahrenheit", "k", "kelvin"]);

function normalize(unit: string): string {
  return unit.trim().toLowerCase().replace(/\s+/g, "");
}

function toCelsius(value: number, unit: string): number {
  if (unit === "c" || unit === "celsius") return value;
  if (unit === "f" || unit === "fahrenheit") return ((value - 32) * 5) / 9;
  return value - 273.15; // kelvin
}

function fromCelsius(value: number, unit: string): number {
  if (unit === "c" || unit === "celsius") return value;
  if (unit === "f" || unit === "fahrenheit") return (value * 9) / 5 + 32;
  return value + 273.15; // kelvin
}

function roundSignificant(value: number): number {
  if (value === 0) return 0;
  return Number(value.toPrecision(10));
}

export const unitConvertTool: ToolDefinition = {
  name: "unit_convert",
  description:
    "Convert a numeric value between units of length, mass, volume, speed, area, digital storage, or temperature " +
    "(celsius/fahrenheit/kelvin). `from` and `to` must be the same category — it is detected automatically from " +
    "the unit names. Not for currency; use currency_convert for money.",
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      value: { type: "number", description: "The numeric value to convert." },
      from: { type: "string", description: 'Source unit, e.g. "km", "lb", "celsius", "mph", "GB".' },
      to: { type: "string", description: 'Target unit, e.g. "mile", "kg", "fahrenheit", "knot", "MiB".' },
    },
    required: ["value", "from", "to"],
    additionalProperties: false,
  },
  async execute(args: { value: number; from: string; to: string }) {
    if (typeof args?.value !== "number" || !Number.isFinite(args.value)) {
      throw new Error("value must be a finite number");
    }
    const from = normalize(String(args?.from ?? ""));
    const to = normalize(String(args?.to ?? ""));
    if (!from || !to) throw new Error("from and to must be non-empty unit strings");

    if (TEMPERATURE_UNITS.has(from) || TEMPERATURE_UNITS.has(to)) {
      if (!TEMPERATURE_UNITS.has(from) || !TEMPERATURE_UNITS.has(to)) {
        throw new Error(`Cannot mix a temperature unit with a non-temperature unit ("${args.from}" -> "${args.to}")`);
      }
      const result = fromCelsius(toCelsius(args.value, from), to);
      return { value: args.value, from: args.from, to: args.to, category: "temperature", result: roundSignificant(result) };
    }

    for (const [category, table] of Object.entries(CATEGORIES)) {
      if (from in table) {
        if (!(to in table)) {
          throw new Error(
            `"${args.to}" is not a ${category} unit (source unit "${args.from}" is). Both units must be the same category.`,
          );
        }
        const base = args.value * table[from]!;
        const result = base / table[to]!;
        return { value: args.value, from: args.from, to: args.to, category, result: roundSignificant(result) };
      }
    }

    throw new Error(
      `Unknown unit "${args.from}". Supported categories: length, mass, volume, temperature, speed, area, digital storage — e.g. "km", "lb", "celsius", "mph", "GB".`,
    );
  },
};
