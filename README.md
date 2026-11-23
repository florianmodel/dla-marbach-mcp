# dla-marbach-mcp

An [MCP](https://modelcontextprotocol.io/) server for the catalog of the
**Deutsches Literaturarchiv Marbach (DLA)**. It lets AI assistants such as Claude search library holdings,
manuscripts, Nachlässe and the DLA subject thesaurus, compare topics and export records.

It is built on the open [DLA Data+ API](https://dataservice.dla-marbach.de/)
([source](https://github.com/dla-marbach/dla-opac-dataservice)). The API exposes **catalog metadata
(CC0), not full texts**.

> Independent community project, not affiliated with or endorsed by the Deutsches Literaturarchiv Marbach.

## Tools

| Tool | What it does |
|---|---|
| `search_archive` | Full-text / Solr search with filters: material type (books, manuscripts, collections, images, persons, …), year range, person, subject heading, digital-only, raw Solr filters. Paged and sortable. |
| `get_record` | One full record by id (`AK…`, `HS…`, `BF…`, `PE…`, `TH…`), as JSON or RIS / MODS / Dublin Core. |
| `explore_topic` | Subject thesaurus lookup: synonyms, broader / narrower / related terms, classification chains, hit counts per material type, sample records. |
| `compare_terms` | Hit-count table for a list of terms, split by material type, for mapping a topic field. |
| `export_results` | Save up to 10,000 hits per call as RIS (Zotero / Citavi / EndNote), JSON / JSONL, TSV, MODS or DC. |
| `list_collections` | Curated data collections (author bibliographies, author libraries, …). |
| `describe_fields` | Catalog field names for field queries (`subject_display_mv:…`, `genre:Brief`, …). |

## Installation

Requires **Node.js 20 or newer**.

### Claude Code

```bash
claude mcp add dla-marbach -- npx -y github:florianmodel/dla-marbach-mcp
```

### Claude Desktop, Cursor, VS Code and other MCP clients

Add this to the client's MCP configuration (for Claude Desktop: *Settings → Developer → Edit Config*,
which opens `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "dla-marbach": {
      "command": "npx",
      "args": ["-y", "github:florianmodel/dla-marbach-mcp"],
      "env": { "DLA_EXPORT_DIR": "/path/to/your/exports" }
    }
  }
}
```

`env` is optional. Restart the client afterwards.

### From source

```bash
git clone https://github.com/florianmodel/dla-marbach-mcp.git
cd dla-marbach-mcp
npm install        # also builds dist/
npm run smoke      # calls every tool against the live API
```

Then point your client at `node /absolute/path/to/dla-marbach-mcp/dist/index.js`.

## Configuration

All settings are optional environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `DLA_EXPORT_DIR` | `./exports` in the server's working directory (`~/dla-marbach-exports` if that is the filesystem root) | Where `export_results` writes files when no `output_path` is given |
| `DLA_RATE_LIMIT` | `55` | Requests per minute the server allows itself |
| `DLA_TIMEOUT_MS` | `60000` | Timeout per API request |
| `DLA_API_URL` | `https://dataservice.dla-marbach.de/v1` | API base URL, e.g. for a local instance |

## Notes

- **Rate limit.** The API allows 60 requests per minute. The server throttles itself, retries `429`
  answers and caches responses for 10 minutes. `compare_terms` costs 5 requests per term (1 without
  the material breakdown) and `explore_topic` about 15, so large comparisons are split over several calls.
- **Query syntax** is Solr: `AND` / `OR` / `NOT`, `"phrases"`, `Arbeit*`, `field:value`.
- **Hits are metadata matches** (titles, subject headings, notes), not matches in the works themselves.
- **Manuscripts** (`HS…`) are described by title, sender / recipient and collection. Subject headings
  are mostly on library records (`AK…`), so search manuscripts with full-text terms and person names.
- **More than 10,000 hits?** One export stops at 10,000. Split the query into disjoint parts
  (`A`, then `(B OR C) NOT A`, or by material type) and export each. Splitting by year drops undated records.
- **Exports write to your local disk.** `export_results` can write to any path the server process can
  write to, so only run it with clients you trust.

## Example prompts

- *Explore the topics Arbeit, Müßiggang, Faulheit, Spiel and Muße and build a search vocabulary.*
- *Compare Lohnarbeit, Arbeitsverweigerung, Recht auf Faulheit, Nichtstun, Spieltrieb, Homo ludens and Grundeinkommen by material type.*
- *Find letters and manuscripts about work or idleness between 1850 and 1980 and group them by Nachlass.*
- *Export everything with the subject heading Müßiggang as RIS for Zotero.*
- *Which letters from Ernst Jünger's Nachlass are digitised?*

## Data and license

- Catalog data: © Deutsches Literaturarchiv Marbach, released under
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) via the DLA data service.
- This code: [0BSD](LICENSE). Use it for anything, no attribution required.
