// Thin client for the DLA Marbach "Data+" catalog API (Apache Solr behind an OpenAPI facade).
// Docs: https://dataservice.dla-marbach.de/  ·  Field list: /v1/info/schema

export const BASE_URL = (process.env.DLA_API_URL ?? "https://dataservice.dla-marbach.de/v1").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.DLA_TIMEOUT_MS ?? 60_000);

export type DlaRecord = Record<string, unknown> & { id: string };
export type Format = "json" | "jsonl" | "tsv" | "dc" | "mods" | "ris";

type ParamValue = string | number | boolean | string[] | undefined;

/** Catalog sources ("source" field) mapped to friendly names. */
export const MATERIALS = {
  books: { code: "AK", label: "Bibliothek (Bücher, Zeitschriften, Drucke)" },
  manuscripts: { code: "HS", label: "Handschriften (Briefe, Manuskripte, Tagebücher, Dokumente)" },
  collections: { code: "BF", label: "Bestände (Nachlässe, Vorlässe, Sammlungen, Verlagsarchive)" },
  images: { code: "BI", label: "Bilder und Objekte" },
  persons: { code: "PE", label: "Personen (Normdaten)" },
  corporations: { code: "KS", label: "Körperschaften (Normdaten)" },
  subjects: { code: "TH", label: "Sachschlagwörter (Thesaurus)" },
  classification: { code: "SE", label: "Systematikketten" },
} as const;
export type Material = keyof typeof MATERIALS;
export const MATERIAL_KEYS = Object.keys(MATERIALS) as [Material, ...Material[]];
export const sourceLabel = (code: string) =>
  Object.values(MATERIALS).find((m) => m.code === code)?.label ?? code;

function buildUrl(path: string, params: Record<string, ParamValue>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) {
      // fields are comma-separated; everything else (fq, sort) is a repeated key
      if (k === "fields") sp.append(k, v.join(","));
      else v.forEach((x) => sp.append(k, x));
    } else sp.append(k, String(v));
  }
  const qs = sp.toString();
  return `${BASE_URL}${path}${qs ? `?${qs}` : ""}`;
}

// --- Rate limiting -----------------------------------------------------------
// The API allows 60 requests per minute per client (X-RateLimit-Limit) and answers 429 beyond that.
// We keep a sliding window slightly under the limit, cap concurrency, retry 429s after Retry-After,
// and cache responses briefly so repeated lookups cost nothing.
const RATE_LIMIT = Number(process.env.DLA_RATE_LIMIT ?? 55); // requests per minute
const MAX_CONCURRENT = 4;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;

const sentAt: number[] = [];
let active = 0;
const waiters: Array<() => void> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function acquire(): Promise<void> {
  while (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  active++;
  for (;;) {
    const now = Date.now();
    while (sentAt.length && now - sentAt[0] >= 60_000) sentAt.shift();
    if (sentAt.length < RATE_LIMIT) {
      sentAt.push(now);
      return;
    }
    await sleep(60_000 - (now - sentAt[0]) + 50);
  }
}
function release(): void {
  active--;
  waiters.shift()?.();
}

const cache = new Map<string, { at: number; body: string }>();

async function get(path: string, params: Record<string, ParamValue> = {}): Promise<string> {
  const url = buildUrl(path, params);
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.body;

  let res: Response | undefined;
  let body = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    await acquire();
    try {
      res = await fetch(url, {
        headers: { "User-Agent": "dla-marbach-mcp/0.1 (MCP research client)" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      body = await res.text();
    } finally {
      release();
    }
    if (res.status !== 429) break;
    const wait = Number(res.headers.get("retry-after") ?? 15);
    await sleep((Number.isFinite(wait) ? wait : 15) * 1000 + 250);
  }
  if (!res) throw new Error(`DLA API: no response for ${url}`);
  if (!res.ok) {
    if (res.status === 429) throw new Error(`DLA API rate limit (60 requests/minute) still exceeded after retries — try again in a minute.`);
    throw new Error(
      `DLA API ${res.status} for ${url}` +
        (res.status === 500
          ? " — usually invalid query syntax, an unknown field, or a field that cannot be sorted."
          : ""),
    );
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(url, { at: Date.now(), body });
  return body;
}

export interface SearchParams {
  q: string;
  fq?: string[];
  fields?: string[];
  sort?: string[];
  /** 1-based offset, as the API expects */
  from?: number;
  size?: number;
}

export async function searchRecords(p: SearchParams): Promise<DlaRecord[]> {
  const body = await get("/records", { ...p, format: "json" });
  // The API answers 204 with an empty body when nothing matches
  return body.trim() ? (JSON.parse(body) as DlaRecord[]) : [];
}

export async function searchRaw(p: SearchParams & { format: Format }): Promise<string> {
  return get("/records", { ...p });
}

export async function countRecords(q: string, fq: string[] = []): Promise<number> {
  const body = await get("/records/count", { q, fq });
  return (JSON.parse(body) as { documentCount: number }).documentCount;
}

export async function getRecord(id: string, format: Format = "json", fields?: string[]): Promise<string> {
  return get(`/record/${encodeURIComponent(id)}.${format}`, { fields });
}

export async function listCollections(): Promise<Array<{ id: number; name: string; url?: string }>> {
  return JSON.parse(await get("/collections"));
}
