import type { ToolDefinition } from "./types.js";
import { config } from "../config.js";

const GEOCODE_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
// Two sequential calls (geocode, then forecast) share the tool's runner
// budget, so each leg gets 60% of the single-request timeout (6s at the
// default) — enough for a slow leg, short enough that one cannot eat the whole
// budget and leave nothing for the other.
const LEG_TIMEOUT_MS = Math.round(config.toolHttpTimeoutMs * 0.6);

// WMO weather interpretation codes, as used by Open-Meteo's `weather_code`.
const WEATHER_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow fall",
  73: "Moderate snow fall",
  75: "Heavy snow fall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

interface GeocodeResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
  timezone?: string;
}

async function geocode(place: string): Promise<GeocodeResult> {
  const url = new URL(GEOCODE_ENDPOINT);
  url.searchParams.set("name", place);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(LEG_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`Geocoding request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`Geocoding service responded ${res.status}`);
  const data = (await res.json()) as { results?: GeocodeResult[] };
  const first = data.results?.[0];
  if (!first) {
    throw new Error(
      `Location not found: "${place}" — try an English place name, optionally with a country, e.g. "Springfield, US".`,
    );
  }
  return first;
}

export const weatherLookupTool: ToolDefinition = {
  name: "weather_lookup",
  description:
    "Get current weather conditions for a place name (city, town, landmark): temperature, feels-like, humidity, " +
    "wind, and a plain-language condition. Geocodes the place then queries Open-Meteo — keyless. Prefer this over " +
    "web_search for weather questions: it is faster and returns structured, current data instead of prose.",
  category: "data",
  parameters: {
    type: "object",
    properties: {
      place: { type: "string", description: 'Place name, e.g. "Seoul", "Paris, France", "Tokyo".' },
      unit: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
        description: "Temperature unit for the result. Defaults to celsius.",
      },
    },
    required: ["place"],
    additionalProperties: false,
  },
  async execute(args: { place: string; unit?: "celsius" | "fahrenheit" }) {
    const place = typeof args?.place === "string" ? args.place.trim() : "";
    if (!place) throw new Error("place must be a non-empty string");
    const fahrenheit = args?.unit === "fahrenheit";

    const location = await geocode(place);

    const url = new URL(FORECAST_ENDPOINT);
    url.searchParams.set("latitude", String(location.latitude));
    url.searchParams.set("longitude", String(location.longitude));
    url.searchParams.set(
      "current",
      "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code",
    );
    url.searchParams.set("temperature_unit", fahrenheit ? "fahrenheit" : "celsius");
    url.searchParams.set("wind_speed_unit", "kmh");
    url.searchParams.set("timezone", "auto");

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(LEG_TIMEOUT_MS) });
    } catch (err) {
      throw new Error(`Forecast request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new Error(`Forecast service responded ${res.status}`);
    const data = (await res.json()) as {
      current?: {
        time: string;
        temperature_2m: number;
        apparent_temperature: number;
        relative_humidity_2m: number;
        wind_speed_10m: number;
        weather_code: number;
      };
      timezone?: string;
    };
    if (!data.current) throw new Error("Forecast service returned no current conditions");

    const c = data.current;
    return {
      place: location.name,
      country: location.country ?? null,
      region: location.admin1 ?? null,
      latitude: location.latitude,
      longitude: location.longitude,
      observedAt: c.time,
      timezone: data.timezone ?? location.timezone ?? null,
      temperature: c.temperature_2m,
      apparentTemperature: c.apparent_temperature,
      unit: fahrenheit ? "F" : "C",
      humidityPercent: c.relative_humidity_2m,
      windSpeedKmh: c.wind_speed_10m,
      conditions: WEATHER_CODES[c.weather_code] ?? `Unknown weather code ${c.weather_code}`,
    };
  },
};
