import { readFileSync } from "node:fs";
import { join } from "node:path";

const files = [
  "AGENTS.md",
  ".pi/SYSTEM.md",
  "memory/confirmed-rules.json",
  "memory/candidate-rules.json",
  "memory/evidence-log.json",
  "evaluation/round-01.json",
  "evaluation/rubric.json"
];
const forbidden = [
  String.fromCharCode(63).repeat(3),
  String.fromCharCode(84, 66, 68),
  String.fromCharCode(91, 24453, 34917, 93),
  String.fromCharCode(0xfffd)
];
const parsedJson = [];

for (const file of files) {
  const content = readFileSync(join(process.cwd(), file), "utf8");
  for (const token of forbidden) {
    if (content.includes(token)) {
      throw new Error(`${file} contains forbidden text: ${JSON.stringify(token)}`);
    }
  }
  if (file.endsWith(".json")) {
    parsedJson.push([file, JSON.parse(content)]);
  }
}

const confirmed = parsedJson.find(([file]) => file === "memory/confirmed-rules.json")[1];
const ids = confirmed.rules.map((rule) => rule.id);
if (ids.length < 5 || ids.length > 8) {
  throw new Error(`Expected 5 to 8 seed rules, found ${ids.length}.`);
}
if (new Set(ids).size !== ids.length) {
  throw new Error("Confirmed rule IDs must be unique.");
}
if (confirmed.rules.some((rule) => rule.status !== "enabled" || rule.confidence !== "confirmed")) {
  throw new Error("Every seed rule must be enabled and confirmed.");
}

console.log(`Experiment files valid. Seed rules: ${ids.length}.`);
