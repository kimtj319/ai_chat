// SAMPLING_PROFILES 해석과 적용 규칙 검사. `npm test` 로 돈다.
process.env.SAMPLING_PROFILES = "deepseek=1.0/1.0, gemma=0.9/0.95";
const { parseSamplingProfiles, samplingDefaultsFor, effectiveSampling } = await import("./samplingProfiles.js");
const { DEFAULT_SETTINGS } = await import("../settings.js");

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: unknown, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("server/chat/samplingProfiles.ts");

{
  const { rules, errors } = parseSamplingProfiles("deepseek=1.0/1.0,Gemma = 0.9 / 0.95");
  check("parses two entries", rules.length === 2 && errors.length === 0, JSON.stringify({ rules, errors }));
  check("pattern is lower-cased", rules[1]?.pattern === "gemma");
}
{
  const { rules, errors } = parseSamplingProfiles("deepseek=1.0,qwen=3/0.5,x=0.5/0,ok=0.5/0.5");
  check("bad entries are reported, not dropped silently", errors.length === 3 && rules.length === 1, JSON.stringify(errors));
}
check("empty string means no profiles", parseSamplingProfiles("").rules.length === 0);

check("model id matches by substring", samplingDefaultsFor("deepseek-ai/DeepSeek-V4.1-Flash-1017")?.temperature === 1);
check("unmatched model has no profile", samplingDefaultsFor("Qwen3.8-27B") === null);

const defaults = { temperature: DEFAULT_SETTINGS.temperature, topP: DEFAULT_SETTINGS.topP };
check(
  "app defaults are replaced by the model's",
  JSON.stringify(effectiveSampling(defaults, "deepseek-ai/DeepSeek-V4.1-Flash-1017")) === JSON.stringify({ temperature: 1, topP: 1 }),
);
check(
  "a changed temperature keeps both of the conversation's values",
  JSON.stringify(effectiveSampling({ temperature: 0.3, topP: DEFAULT_SETTINGS.topP }, "deepseek-x")) ===
    JSON.stringify({ temperature: 0.3, topP: DEFAULT_SETTINGS.topP }),
);
check(
  "a model without a profile keeps the app defaults",
  JSON.stringify(effectiveSampling(defaults, "Qwen3.8-27B")) === JSON.stringify(defaults),
);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
