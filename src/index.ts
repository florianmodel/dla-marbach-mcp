#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  BASE_URL,
  MATERIALS,
  MATERIAL_KEYS,
  type DlaRecord,
  type Format,
  type Material,
  countRecords,
  getRecord,
  listCollections,
  searchRaw,
  searchRecords,
  sourceLabel,
} from "./api.js";

const server = new McpServer({ name: "dla-marbach", version: "0.1.0" });

// Where export_results writes when no output_path is given. Desktop MCP clients often start servers
// with "/" as working directory, so fall back to the home folder there.
const EXPORT_DIR = path.resolve(
  process.env.DLA_EXPORT_DIR ??
    (process.cwd() === path.parse(process.cwd()).root
      ? path.join(homedir(), "dla-marbach-exports")
      : path.join(process.cwd(), "exports")),
);

// ---------------------------------------------------------------------------
// Shared filter handling
// ---------------------------------------------------------------------------

const QUERY_HELP =
  "Solr query. Supports AND / OR / NOT, \"phrases\", trailing wildcard (Arbeit*), and field search " +
  "(field:value), e.g. subject_display_mv:Müßiggang, searchName_mv:\"Kafka, Franz\", genre:Tagebuch, " +
  "titleMain_text:Faulheit. Use * to match everything (combine with filters).";

const filterShape = {
  material: z
    .array(z.enum(MATERIAL_KEYS))
    .optional()
    .describe(
      "Restrict to material types: " +
        Object.entries(MATERIALS).map(([k, v]) => `${k} = ${v.label}`).join("; "),
    ),
  year_from: z.number().int().optional().describe("Earliest year (date of origin/publication)"),
  year_to: z.number().int().optional().describe("Latest year (date of origin/publication)"),
  person: z
    .string()
    .optional()
    .describe('Person or corporation linked to the record, best as "Surname, Forename" (e.g. "Kafka, Franz")'),
  subject: z
    .string()
    .optional()
    .describe("Exact DLA subject heading (Sachschlagwort), e.g. Müßiggang, Arbeit, Spiel. Find headings with explore_topic."),
  digital_only: z.boolean().optional().describe("Only records with a digital object (digitised or e-resource)"),
  extra_filters: z
    .array(z.string())
    .optional()
    .describe(
      'Raw Solr filter queries, e.g. filterCollection_mv:"A:Jünger, Ernst", filterLanguage_mv:Französisch, ' +
        'genre:Brief, filterFormContent_mv:Lyrik, usageRestriction:benutzbar',
    ),
};
type Filters = {
  material?: Material[];
  year_from?: number;
  year_to?: number;
  person?: string;
  subject?: string;
  digital_only?: boolean;
  extra_filters?: string[];
};

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function buildFq(f: Filters): string[] {
  const fq: string[] = [];
  if (f.material?.length) fq.push(`source:(${f.material.map((m) => MATERIALS[m].code).join(" OR ")})`);
  if (f.year_from !== undefined || f.year_to !== undefined)
    fq.push(`searchDate_mv:[${f.year_from ?? "*"} TO ${f.year_to ?? "*"}]`);
  if (f.person) fq.push(`searchName_mv:${quote(f.person)}`);
  if (f.subject) fq.push(`filterSubject_mv:${quote(f.subject)}`);
  if (f.digital_only) fq.push("filterDigital:true");
  if (f.extra_filters) fq.push(...f.extra_filters);
  return fq;
}

// ---------------------------------------------------------------------------
// Record formatting
// ---------------------------------------------------------------------------

const SUMMARY_FIELDS = [
  "id", "source", "display", "displayAddition1", "displayAddition2", "filterSource", "category",
  "genre", "searchDate_mv", "filterDateRange_mv", "personBy_display_mv", "personTo_display_mv",
  "personAbout_display_mv", "corporationBy_display_mv", "subject_display_mv", "headword_mv",
  "collection_display_mv", "extent", "usageRestriction", "item_usageRestriction_mv",
  "digitalObject_hyperlink_mv", "digitalObject_accessLevel_mv", "item_digitalObject_hyperlink_mv",
  "noteFootnote_text_mv", "dateLifespanStart", "dateLifespanEnd", "url",
];

const arr = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])
    .map(String)
    .filter((s) => s.trim() && s !== "␣");
const uniq = (xs: string[]) => [...new Set(xs)];
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function dateOf(r: DlaRecord): string | undefined {
  const raw = arr(r.filterDateRange_mv).concat(arr(r.searchDate_mv));
  if (!raw.length) return undefined;
  const years = raw.flatMap((s) => s.match(/\d{3,4}/g) ?? []).map(Number);
  if (!years.length) return raw[0];
  const lo = Math.min(...years), hi = Math.max(...years);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

function summarize(r: DlaRecord, i?: number): string {
  const lines: string[] = [];
  const head = `${i !== undefined ? `${i}. ` : ""}**${r.display ?? r.id}**`;
  lines.push(head);
  const meta: string[] = [`id ${r.id}`, String(r.filterSource ?? sourceLabel(String(r.source ?? "")))];
  if (r.genre) meta.push(String(r.genre));
  const d = dateOf(r);
  if (d) meta.push(d);
  if (r.source === "PE" && (r.dateLifespanStart || r.dateLifespanEnd))
    meta.push(`${r.dateLifespanStart ?? "?"}–${r.dateLifespanEnd ?? ""}`);
  lines.push("   " + meta.join(" · "));
  const people = uniq([...arr(r.personBy_display_mv), ...arr(r.corporationBy_display_mv)]);
  if (people.length) lines.push(`   von: ${clip(people.slice(0, 5).join("; "), 200)}`);
  const to = arr(r.personTo_display_mv);
  if (to.length) lines.push(`   an: ${clip(uniq(to).slice(0, 3).join("; "), 150)}`);
  const about = arr(r.personAbout_display_mv);
  if (about.length) lines.push(`   über: ${clip(uniq(about).slice(0, 3).join("; "), 150)}`);
  const subj = uniq([...arr(r.subject_display_mv), ...arr(r.headword_mv)]);
  if (subj.length) lines.push(`   Schlagwörter: ${clip(subj.slice(0, 8).join(", "), 200)}`);
  const coll = arr(r.collection_display_mv);
  if (coll.length) lines.push(`   Bestand: ${clip(coll[0], 150)}`);
  else if (r.displayAddition1) lines.push(`   ${clip(String(r.displayAddition1), 150)}`);
  const digital = uniq([...arr(r.digitalObject_hyperlink_mv), ...arr(r.item_digitalObject_hyperlink_mv)]);
  if (digital.length) {
    const access = arr(r.digitalObject_accessLevel_mv)[0];
    lines.push(`   Digitalisat${access ? ` (${access})` : ""}: ${digital[0]}`);
  }
  const usage = r.usageRestriction ?? arr(r.item_usageRestriction_mv)[0];
  if (usage) lines.push(`   Benutzung: ${usage}`);
  lines.push(`   ${r.url ?? `https://www.dla-marbach.de/find/opac/id/${r.id}`}`);
  return lines.join("\n");
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.registerTool(
  "search_archive",
  {
    title: "Search the DLA Marbach catalog",
    description:
      "Full-text search across the Deutsches Literaturarchiv Marbach catalog: library holdings, manuscripts " +
      "(letters, drafts, diaries), Nachlässe/collections, images & objects, plus authority data. Returns the " +
      "total hit count and a page of compact records. Note: the API exposes catalog metadata, not full texts.",
    inputSchema: {
      query: z.string().min(1).describe(QUERY_HELP),
      ...filterShape,
      sort: z
        .enum(["relevance", "title", "date_asc", "date_desc"])
        .default("relevance")
        .describe("Sort order"),
      size: z.number().int().min(1).max(100).default(20).describe("Records per page (max 100)"),
      offset: z.number().int().min(0).default(0).describe("Number of records to skip (for paging)"),
      fields: z
        .array(z.string())
        .optional()
        .describe("Return these raw fields instead of the summary (wildcards allowed, e.g. person*). See describe_fields."),
    },
  },
  async ({ query, sort, size, offset, fields, ...f }) => {
    try {
      const fq = buildFq(f);
      const sortMap = {
        relevance: undefined,
        title: ["sortingTitleMain asc"],
        date_asc: ["searchDate_mv asc"],
        date_desc: ["searchDate_mv desc"],
      } as const;
      const [total, records] = await Promise.all([
        countRecords(query, fq),
        searchRecords({
          q: query,
          fq,
          size,
          from: offset + 1,
          sort: sortMap[sort] ? [...sortMap[sort]!] : undefined,
          fields: fields ?? SUMMARY_FIELDS,
        }),
      ]);
      const header =
        `${total} Treffer für ${quote(query)}` +
        (fq.length ? ` (Filter: ${fq.join(" ∧ ")})` : "") +
        ` — zeige ${records.length ? `${offset + 1}–${offset + records.length}` : "keine"}`;
      if (fields) return text(header + "\n\n" + JSON.stringify(records, null, 1));
      const body = records.map((r, i) => summarize(r, offset + i + 1)).join("\n\n");
      const more = offset + records.length < total ? `\n\n… weitere Treffer mit offset=${offset + records.length}` : "";
      return text(`${header}\n\n${body}${more}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_record",
  {
    title: "Get a catalog record",
    description:
      "Fetch one full record by id (e.g. HS00074116, AK01572315, PE00019944, TH00019534, BF00013009). " +
      "JSON returns every catalog field; ris/mods/dc give citation formats (title records only).",
    inputSchema: {
      id: z.string().regex(/^[A-Z]{2}\d+$/, "ids look like AK01572315").describe("Record id"),
      format: z.enum(["json", "ris", "mods", "dc", "tsv"]).default("json"),
    },
  },
  async ({ id, format }) => {
    try {
      const raw = await getRecord(id, format as Format);
      if (!raw.trim()) return text(`No record with id ${id}.`);
      if (format !== "json") return text(raw);
      const [rec] = JSON.parse(raw) as DlaRecord[];
      if (!rec) return text(`No record with id ${id}.`);
      const cleaned = Object.fromEntries(
        Object.entries(rec)
          .map(([k, v]) => [k, Array.isArray(v) ? arr(v) : v] as const)
          .filter(([, v]) => !(Array.isArray(v) && v.length === 0)),
      );
      return text(summarize(rec) + "\n\n```json\n" + JSON.stringify(cleaned, null, 1) + "\n```");
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "explore_topic",
  {
    title: "Explore a subject heading",
    description:
      "Look up a term in the DLA subject thesaurus (Sachschlagwörter): matching headings, synonyms, broader, " +
      "narrower and related terms, the DLA classification chains it appears in, and how many records of each " +
      "material type are indexed with it — compared with plain full-text hits. Use this to build a vocabulary " +
      "before searching (e.g. Arbeit → Erwerbsarbeit, Müßiggang → Muße).",
    inputSchema: {
      term: z.string().min(1).describe("Topic, e.g. Arbeit, Müßiggang, Spiel, Faulheit"),
      heading_id: z.string().optional().describe("Specific TH… id to expand, if several headings matched"),
      sample: z.number().int().min(0).max(20).default(5).describe("Example records to show for the heading"),
    },
  },
  async ({ term, heading_id, sample }) => {
    try {
      const out: string[] = [];
      const candidates = await searchRecords({
        q: heading_id ? `id:${heading_id}` : `display:${quote(term)} OR usedFor_display_mv:${quote(term)}`,
        fq: ["source:TH"],
        size: 10,
        fields: ["id", "display", "category", "useTerm_display_mv", "usedFor_display_mv"],
      });
      if (!candidates.length) {
        const n = await countRecords(term);
        return text(`No subject heading found for ${quote(term)}. Full-text hits: ${n}. Try a variant or a broader term.`);
      }
      const norm = (s: unknown) => String(s ?? "").toLowerCase();
      const best =
        candidates.find((c) => norm(c.display) === norm(term) && c.category === "Deskriptor") ??
        candidates.find((c) => c.category === "Deskriptor") ??
        candidates[0];

      out.push(
        `Gefundene Schlagwörter für ${quote(term)}: ` +
          candidates.map((c) => `${c.display} (${c.id}${c.category === "Nichtdeskriptor" ? ", Verweisung" : ""})`).join("; "),
      );

      const [h] = JSON.parse(await getRecord(best.id)) as DlaRecord[];
      // A Nichtdeskriptor points to its preferred term via useTerm
      out.push(`\n## ${h.display} (${h.id})`);
      if (arr(h.useTerm_display_mv).length) out.push(`→ benutze: ${arr(h.useTerm_display_mv).join(", ")}`);
      if (arr(h.usedFor_display_mv).length) out.push(`Synonyme/Verweisungen: ${arr(h.usedFor_display_mv).join(", ")}`);

      const relTypes = arr(h.relation_type_mv), relTexts = arr(h.relation_text_mv), relIds = arr(h.relation_id_mv);
      const groups = new Map<string, string[]>();
      relTypes.forEach((t, i) => groups.set(t, [...(groups.get(t) ?? []), `${relTexts[i]} (${relIds[i]})`]));
      for (const [t, xs] of groups) out.push(`${t}: ${xs.join(", ")}`);

      const broader = await searchRecords({ q: `child_id_mv:${h.id}`, fq: ["source:TH"], size: 20, fields: ["id", "display"] });
      if (broader.length) out.push(`Oberbegriffe: ${broader.map((b) => `${b.display} (${b.id})`).join(", ")}`);
      const refs = arr(h.reference_text_mv).filter((s) => /^[A-Za-zÀ-ž][\w\s,'-]+$/.test(s) && s.length > 2 && !/^lcsh$/i.test(s));
      if (refs.length) out.push(`Fremdsprachige Entsprechungen: ${uniq(refs).join(", ")}`);
      if (arr(h.gnd_id_mv).length) out.push(`GND: ${arr(h.gnd_id_mv).map((g) => `https://d-nb.info/gnd/${g}`).join(", ")}`);

      // Distribution across material types: indexed with the heading vs. plain full-text
      const types: Material[] = ["books", "manuscripts", "collections", "images"];
      const subjFq = `subject_id_mv:${h.id}`;
      const counts = await Promise.all(
        types.flatMap((m) => [
          countRecords(subjFq, [`source:${MATERIALS[m].code}`]),
          countRecords(quote(String(h.display)), [`source:${MATERIALS[m].code}`]),
        ]),
      );
      out.push(`\n| Material | mit Schlagwort | Volltext „${h.display}“ |\n|---|---:|---:|`);
      types.forEach((m, i) => out.push(`| ${MATERIALS[m].label} | ${counts[2 * i]} | ${counts[2 * i + 1]} |`));

      const chains = await searchRecords({ q: subjFq, fq: ["source:SE"], size: 25, fields: ["id", "display"] });
      if (chains.length) out.push(`\nSystematikstellen (Bibliothek):\n${chains.map((c) => `- ${c.display}`).join("\n")}`);

      if (sample > 0) {
        const recs = await searchRecords({
          q: subjFq,
          fq: ["-source:(SE OR TH)"],
          size: sample,
          fields: SUMMARY_FIELDS,
        });
        if (recs.length) out.push(`\nBeispiele (search_archive mit subject=${quote(String(h.display))} für mehr):\n\n${recs.map((r, i) => summarize(r, i + 1)).join("\n\n")}`);
      }
      return text(out.join("\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "compare_terms",
  {
    title: "Compare hit counts for several terms",
    description:
      "Count catalog hits for a list of terms or queries, broken down by material type. Useful for mapping a " +
      "topic field (e.g. Lohnarbeit vs. Müßiggang vs. Spieltrieb) and spotting where manuscripts cluster. " +
      "Shared filters (years, person, …) apply to every term. Costs 5 API requests per term (1 without " +
      "by_material); the API allows ~60 requests/minute, so one call counts at most 10 terms (50 without " +
      "by_material) and returns the remaining terms to request next.",
    inputSchema: {
      terms: z.array(z.string().min(1)).min(1).max(30).describe("Terms or full Solr queries, one per row"),
      by_material: z.boolean().default(true).describe("Break counts down by books/manuscripts/collections/images"),
      ...filterShape,
    },
  },
  async ({ terms, by_material, ...f }) => {
    try {
      const fq = buildFq(f);
      const cols: Array<{ label: string; fq: string[] }> = [{ label: "gesamt", fq }];
      if (by_material)
        for (const m of ["books", "manuscripts", "collections", "images"] as Material[])
          cols.push({ label: m, fq: [...fq, `source:${MATERIALS[m].code}`] });
      // Keep each call within ~50 requests so it finishes in about a minute under the API rate limit.
      const perCall = Math.max(1, Math.floor(50 / cols.length));
      const batch = terms.slice(0, perCall);
      const rest = terms.slice(perCall);
      const rows = await Promise.all(
        batch.map(async (t) => {
          const q = /[:"()*]|\b(AND|OR|NOT)\b/.test(t) ? t : quote(t);
          return [t, ...(await Promise.all(cols.map((c) => countRecords(q, c.fq))))] as const;
        }),
      );
      const head = `| Begriff | ${cols.map((c) => c.label).join(" | ")} |\n|---|${cols.map(() => "---:").join("|")}|`;
      const body = rows.map((r) => `| ${r[0]} | ${r.slice(1).join(" | ")} |`).join("\n");
      const tail = rest.length
        ? `\n\nRate limit: only the first ${batch.length} terms were counted. Call compare_terms again with: ${JSON.stringify(rest)}`
        : "";
      return text((fq.length ? `Filter: ${fq.join(" ∧ ")}\n\n` : "") + head + "\n" + body + tail);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "export_results",
  {
    title: "Export search results to a file",
    description:
      "Run a search and save up to `max` matching records to a local file (RIS for Zotero/Citavi, JSON/JSONL " +
      "for analysis, TSV for spreadsheets, MODS or Dublin Core XML). Returns the file path.",
    inputSchema: {
      query: z.string().min(1).describe(QUERY_HELP),
      ...filterShape,
      format: z.enum(["ris", "json", "jsonl", "tsv", "mods", "dc"]).default("ris"),
      max: z.number().int().min(1).max(10000).default(500).describe("Maximum number of records"),
      output_path: z
        .string()
        .optional()
        .describe(
          `File to write. Defaults to <query>-<date>.<ext> in ${EXPORT_DIR} (set DLA_EXPORT_DIR to change)`,
        ),
    },
  },
  async ({ query, format, max, output_path, ...f }) => {
    try {
      const fq = buildFq(f);
      const total = await countRecords(query, fq);
      if (total === 0) return text(`No records match ${quote(query)} — nothing exported.`);
      const data = await searchRaw({ q: query, fq, size: max, from: 1, format: format as Format });
      const ext = { ris: "ris", json: "json", jsonl: "jsonl", tsv: "tsv", mods: "xml", dc: "xml" }[format];
      const slug = query.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60) || "export";
      const file = path.resolve(
        output_path ?? path.join(EXPORT_DIR, `${slug}-${new Date().toISOString().slice(0, 10)}.${ext}`),
      );
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, data, "utf8");
      const written = Math.min(max, total);
      return text(
        `Saved ${written} of ${total} records (${format}) to ${file}` +
          (total > max
            ? max < 10000
              ? `\nRaise max (up to 10000) to export more.`
              : `\nMore than 10000 hits: split the query into disjoint parts (e.g. "A" and "(B OR C) NOT A", ` +
                `or by material type) and export each part. Splitting by year range drops undated records.`
            : "") +
          (["ris", "mods", "dc"].includes(format) ? "\nNote: ris/mods/dc include title records only, not authority data." : ""),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_collections",
  {
    title: "List curated data collections",
    description: "List the curated collections published through the DLA data service (e.g. author bibliographies, author libraries).",
    inputSchema: {},
  },
  async () => {
    try {
      const cs = await listCollections();
      return text(cs.map((c) => `- ${c.id}: ${c.name}${c.url ? ` — ${c.url}` : ""}`).join("\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "describe_fields",
  {
    title: "List searchable catalog fields",
    description:
      "List catalog field names (optionally filtered by a substring) for field-specific queries, filters and the `fields` option.",
    inputSchema: { contains: z.string().optional().describe("Substring to filter field names, e.g. person, date, subject") },
  },
  async ({ contains }) => {
    try {
      const res = await fetch(`${BASE_URL}/info/schema`, { signal: AbortSignal.timeout(30_000) });
      const fields = (await res.json()) as Array<{ name: string; type: string }>;
      const sel = contains ? fields.filter((x) => x.name.toLowerCase().includes(contains.toLowerCase())) : fields;
      return text(
        sel.map((x) => `${x.name} (${x.type})`).join("\n") +
          "\n\nField reference: https://github.com/dla-marbach/dla-opac-transform/blob/main/docs/internformat.csv",
      );
    } catch (e) {
      return fail(e);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
