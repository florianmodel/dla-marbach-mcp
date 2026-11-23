// End-to-end smoke test: starts the server over stdio and calls every tool against the live API.
// Usage: npm run build && npm run smoke
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, "index.js")] }));

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const calls: Array<[string, Record<string, unknown>]> = [
  ["search_archive", { query: "Müßiggang", size: 3 }],
  ["search_archive", { query: "Arbeit", material: ["manuscripts"], year_from: 1900, year_to: 1950, sort: "date_asc", size: 3 }],
  ["search_archive", { query: "*", subject: "Spiel", material: ["books"], size: 2 }],
  ["get_record", { id: "TH00019534" }],
  ["get_record", { id: "AK01572315", format: "ris" }],
  ["explore_topic", { term: "Müßiggang", sample: 2 }],
  ["explore_topic", { term: "Arbeit", sample: 0 }],
  ["compare_terms", { terms: ["Lohnarbeit", "Müßiggang", "Faulheit", "Spieltrieb", "Homo ludens"] }],
  ["export_results", { query: "Müßiggang", format: "ris", max: 50, output_path: path.join(tmpdir(), "dla-smoke.ris") }],
  ["list_collections", {}],
  ["describe_fields", { contains: "date" }],
];

let failed = 0;
for (const [name, args] of calls) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text?: string }>; isError?: boolean };
  const out = res.content.map((c) => c.text ?? "").join("\n");
  if (res.isError) failed++;
  console.log(`\n===== ${name} ${JSON.stringify(args)} ${res.isError ? "❌" : "✅"}\n${out.slice(0, 1500)}${out.length > 1500 ? "\n[…]" : ""}`);
}
await client.close();
if (failed) {
  console.error(`\n${failed} call(s) failed`);
  process.exit(1);
}
