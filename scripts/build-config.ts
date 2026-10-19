// Compiles bands.yaml → src/config/generated.json (committed). Build-time only: the
// Worker imports the JSON and never parses YAML. Exits non-zero, naming the YAML path
// and line of every bad field, so a typo fails `task check` / `task test` on Mat's
// machine rather than a guest's upload.
//
//   node scripts/build-config.ts [input.yaml] [output.json]
import { readFileSync, writeFileSync } from "node:fs";
import { LineCounter, parseDocument } from "yaml";
import { formatPath, validateConfig } from "../src/config/schema.ts";

const [input = "bands.yaml", output = "src/config/generated.json"] = process.argv.slice(2);

const lines = new LineCounter();
// Core schema: YAML 1.2, so 2026-10-10T21:00-04:00 stays a string (no 1.1 timestamps).
const doc = parseDocument(readFileSync(input, "utf8"), { schema: "core", lineCounter: lines, prettyErrors: true });

if (doc.errors.length > 0) {
  for (const e of doc.errors) console.error(`${input}: ${e.message}`);
  process.exit(1);
}

const res = validateConfig(doc.toJS());
if (!res.ok) {
  console.error(`${input}: invalid config`);
  for (const issue of res.issues) {
    const node = doc.getIn(issue.path, true) as { range?: [number, number] } | undefined;
    const at = node?.range ? `:${lines.linePos(node.range[0]).line}` : "";
    console.error(`  ${input}${at} ${formatPath(issue.path)}: ${issue.message}`);
  }
  process.exit(1);
}

writeFileSync(output, JSON.stringify(res.config, null, 2) + "\n");
console.log(`${input} → ${output} (${res.config.bands.map((b) => b.slug).join(", ")})`);
