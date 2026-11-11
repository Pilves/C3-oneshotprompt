## Prompts

This repository was built by Claude Code from two prompts:

> be product owner, read through task.md, figure everything out on your own, /goal working application that solves task.md

> hire fable advisor for architecture and then 5.5 opus agents to implement

# Findings search

A small web application and MCP server for searching and browsing OSINT findings (domains, IP addresses, email addresses, handles, aliases and crypto wallets), grouped into cases. One Node.js process serves the UI, an HTTP API and a Streamable HTTP MCP endpoint (protocol revision 2026-07-28) over the provided `findings.json`. There are no runtime dependencies.

The assignment is in [docs/task.md](docs/task.md) (in Estonian). The full rationale, including every decision summarised below, is in [docs/DESIGN.md](docs/DESIGN.md).

## Run with Docker

```sh
docker compose up --build
```

Open <http://localhost:3000>. `docker compose ps` shows the container as `(healthy)` within a few seconds of starting. Stop it with Ctrl-C or `docker compose down`.

To use another port:

```sh
PORT=8080 docker compose up --build
```

The port is published on `127.0.0.1` only, and the server answers only requests whose `Host` (and `Origin`, when a browser sends one) is `localhost`, `127.0.0.1` or `[::1]`. That is deliberate: there is no authentication ([DESIGN 8](docs/DESIGN.md#8-security-posture)). To reach it from another machine, change the mapping in `compose.yaml` from `"127.0.0.1:${PORT:-3000}:3000"` to `"${PORT:-3000}:3000"` and name the host name clients will use:

```sh
ALLOWED_HOSTS=findings.lan docker compose up --build
```

## Run without Docker

Node.js 22 or later. There is nothing to install.

```sh
node src/server.js
```

It listens on `127.0.0.1:3000` and logs what it loaded, including a count per data-quality flag. Settings come from the environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on. In Compose it is the published port on the host instead |
| `HOST` | `127.0.0.1` | Address to bind. The image sets `0.0.0.0`, because a container must listen on all its interfaces to be published |
| `DATA_FILE` | `findings.json` in the repository root | The dataset |
| `ALLOWED_HOSTS` | (empty) | Comma-separated host names accepted in `Host` and `Origin`, in addition to the loopback names |
| `MCP_RATE_LIMIT_PER_MIN` | `120` | MCP tool calls per client address per minute; `0` disables the limit |

## Tests

```sh
npm test
```

This runs the whole suite with `node --test`, without installing anything. The one exception is the interoperability test, which needs the official MCP client as a dev dependency and is reported as skipped until it is installed:

```sh
npm ci
npm test
```

What the tests cover is listed in [DESIGN 9](docs/DESIGN.md#9-testing). Browser rendering is checked by hand; see [the checklist](#manual-browser-check) below.

## Try the API

```sh
curl -s 'http://localhost:3000/api/findings?q=ongitsus&type=ip&limit=1'
curl -s http://localhost:3000/api/findings/F-10578-2
curl -s http://localhost:3000/api/cases
```

`/api/findings` takes `q`, `type` (comma-separated or repeated), `case` (`C-104` or `unassigned`), `from` and `to` (`YYYY-MM-DD` or a date-time with a zone), `limit` (1–100, default 20), `offset` and `includeDuplicates`. Each result carries `highlights`: `[start, end)` offsets into its `entity` and `notes`. Invalid parameters give a `400` that names each one. See [DESIGN 5](docs/DESIGN.md#5-http-api).

## Try MCP

The endpoint is `POST http://localhost:3000/mcp`. Revision 2026-07-28 has no handshake and no session: every request states the protocol version in the `MCP-Protocol-Version` header and in `params._meta`, and repeats its method in `Mcp-Method` (and the tool name in `Mcp-Name` for `tools/call`).

```sh
curl -s http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: server/discover' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'

curl -s http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'

curl -s http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/call' \
  -H 'Mcp-Name: search_findings' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_findings","arguments":{"query":"ongitsus","limit":2},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

Leave out `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` or one of the two `_meta` fields and the answer is a `400` that names what is missing. (A request with none of the 2026-07-28 markers at all is treated as a 2025 client; see below.)

| Tool | Arguments | Returns |
| --- | --- | --- |
| `search_findings` | `query` (required, may be empty), `types`, `caseId`, `from`, `to`, `limit`, `offset`, `includeDuplicates` | `{ dataNotice, total, limit, offset, results }` |
| `get_finding` | `id` | `{ dataNotice, finding }`, including the original record as `raw` |
| `list_cases` | none | `{ cases, unassigned, note }` |

Every result that contains evidence starts with `dataNotice`, a fixed statement that the finding fields are untrusted third-party text, because some notes in the data are written to hijack an AI client ([DESIGN 6.5](docs/DESIGN.md#65-tools-and-untrusted-content)).

**Clients that still use the 2025 handshake work too.** A client that opens with `initialize` gets a stateless answer and can then list and call the tools ([DESIGN 6.3](docs/DESIGN.md#63-legacy-clients-a-stateless-dual-era-fallback)). This covers the official TypeScript client `@modelcontextprotocol/client` 2.4.0 in its default configuration and the v1 SDK `@modelcontextprotocol/sdk` 1.32.2 (checked by hand). To make the v2 client speak 2026-07-28 instead:

```js
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'example', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp')));
const result = await client.callTool({ name: 'search_findings', arguments: { query: 'õngitsus' } });
```

`{ mode: 'auto' }` also ends up on 2026-07-28 with this server. [`test/mcp/interop.test.js`](test/mcp/interop.test.js) runs all three modes.

## Architecture decisions

**One process, data in memory, linear scan.** The file is normalised once at start-up and kept in memory; each query scans 1032 pre-folded records, which takes about a millisecond on the development machine. There is no database because the data is small and read-only, and because Estonian needs substring matching: `kampaania` must find `õngitsuskampaanias`, which a tokenising full-text index does not do. SQLite FTS5 through `node:sqlite` was tried and rejected for that reason; it is the first step if the data grows. See [DESIGN 3](docs/DESIGN.md#3-storage-and-search).

**Search for two languages.** Query and text are folded (lower case, diacritics removed) with a map back to the original offsets, so `sokolaadimees` finds `Šokolaadimees` and the highlight covers the original characters. Every word must match the entity or the notes. Each word is tried as typed, then with up to three letters cut off (`sisselogimine` finds `sisselogimisi`), then through a small Estonian/English glossary (`phishing` finds `õngitsus`); the ranking follows that order. The server computes the highlight ranges, so the UI never re-implements matching. See [DESIGN 3.3](docs/DESIGN.md#33-matching-rules) and [3.4](docs/DESIGN.md#34-what-estonian-and-english-means-here).

**One core, two thin adapters.** `src/core/` owns normalisation, parameter validation, search and lookups. The HTTP API and the MCP tools call the same three store functions through the same validator, so the UI and an AI client cannot get different answers to the same question; the end-to-end test checks exactly that. See [DESIGN 2](docs/DESIGN.md#2-architecture).

**A hand-written MCP server.** When this was built, the v1 SDK did not support revision 2026-07-28 and the v2 SDK would have brought `zod` and a second validation path. The surface needed is small (three tools, JSON responses, no sessions), so the handler is written against the specification and checked two ways: about forty transport probes compared with the reference server, and the official client in all its negotiation modes. It also serves 2025 clients without keeping state. See [DESIGN 6](docs/DESIGN.md#6-mcp-interface).

**A plain static UI.** One HTML page, vanilla JavaScript, no framework and no build step. Search state lives in the URL fragment, so searches and findings can be linked and the back button works. All untrusted text goes into the page through `textContent`, never parsed as HTML, and a strict Content Security Policy is the second layer. See [DESIGN 7](docs/DESIGN.md#7-ui).

**Security sized to a local tool.** Host and Origin allowlist on every route (against DNS rebinding and cross-site reads), loopback-only publishing, non-root read-only container with all capabilities dropped, request and result size limits, a rate limit on tool calls, and evidence kept apart from the server's own text in MCP results. There is no authentication; [DESIGN 8](docs/DESIGN.md#8-security-posture) says what a real deployment would add.

## Data handling: assumptions and trade-offs

The rule throughout: **normalise for retrieval, never overwrite.** Every finding keeps its original record verbatim as `raw`, shown in the detail view and by `get_finding`. Canonical fields exist so that filtering and duplicate detection work. Anything an analyst should know about becomes a flag rather than a silent fix. Only cosmetic tidying (whitespace, the letter case of a label) goes unflagged, and it is visible by comparing with `raw`. A bad record never stops the load.

**Result: 1032 records → 1032 findings with unique ids → 1002 distinct findings + 30 re-ingested duplicates, in 40 cases, plus one finding (`F-10767`) with no case.**

| Field | What the data does | What the application does |
| --- | --- | --- |
| `id` | `F-10578` and `F-10401` are each used by two unrelated records | The second record becomes `F-10578-2` / `F-10401-2`. Both get `duplicate_id` and link to each other. Lookup by id stays unambiguous and nothing is hidden |
| (whole record) | Every `F-200xx` record repeats an `F-10xxx` one, differing at most by whitespace, letter case, epoch vs ISO time, `utm_*` parameters or a trailing slash | Linked when entity (case-insensitive), cases, instant, cleaned URL and notes all match: exactly 30 pairs. The lower id is canonical; the copy gets `reingested_duplicate` and `duplicateOf`. Copies are hidden from search and case counts unless "show duplicates" is ticked, and can still be opened by id |
| `type` | 7 non-canonical labels (`ipv4`, `" email "`, `url`, `Domain`, `IP`, `ALIAS`, `Handle`); 5 contradict the value | Where the value has a checkable shape (IP, email, domain, EVM wallet), the shape is the type, and a contradicting label gets `type_mismatch`. Handles and aliases have no checkable shape, so their label is trusted. `IP` on `zephyr_raven92` becomes `unknown`. The original label is shown wherever it differs |
| `caseId` | `" c-117"`, one array of two cases, one `null` | Trimmed and upper-cased. The array becomes two cases (`multi_case`) and the finding counts in both. `null` becomes no case (`case_missing`), reachable with the case filter "unassigned" |
| `observedAt` | 730 ISO with `Z`, 180 with `+02:00`/`+03:00`, 122 epoch numbers | All converted to UTC. Numbers are read as milliseconds; read that way, they fall in the same two months as the rest. A time without a zone would be rejected, not guessed |
| `sourceUrl` | One `javascript:`, one `data:`, one without a scheme, one empty; 7 with `utm_*` parameters, 5 with trailing slashes | Only `http(s)` URLs become links. The rest are shown as text with the reason (`source_unsafe`, `source_missing`). The schemeless one gets `https://` and `source_scheme_assumed`. Tracking parameters stay in the link because they are evidence; they are ignored only for duplicate detection |
| `entity` | 4 with surrounding spaces, 3 emails in upper case | Trimmed. Letter case is kept (it is how the value was written where it was found) but compared case-insensitively |
| `notes` | 4 missing, 3 `null`; 7 containing HTML or entities; 4 written to steer an AI | Missing and `null` become `""` with `notes_missing`. Markup is stored and shown as literal text, and `&lt;` is not decoded (`notes_markup`). AI-directed text is delivered unchanged and flagged `notes_instruction_like` |

Flag counts on this dataset, as logged at start-up: `reingested_duplicate` 30, `notes_missing` 7, `notes_markup` 7, `type_mismatch` 5, `duplicate_id` 4, `notes_instruction_like` 4, `source_unsafe` 2, `case_missing` 1, `multi_case` 1, `source_missing` 1, `source_scheme_assumed` 1. Five more flags (`id_missing`, `entity_missing`, `case_invalid`, `time_invalid`, `source_invalid`) handle malformed input that this file does not contain.

Trade-offs taken knowingly:

- **Folding `õ ä ö ü` to `o a o u`** merges letters that are distinct in Estonian. Analysts often type without diacritics, and a missed finding costs more than an extra one.
- **The value's shape beats the label**, so that a filter for IP addresses returns all of them. The label is kept and shown, so the original claim is not lost.
- **The lowest id is the canonical record.** The data has no import dates, so that is the only ordering available; reading `F-200xx` as "a later import" is an inference.
- **The two notes flags are heuristics**, easy to evade. They are signals for the analyst, not a safety mechanism. Nothing is removed or rewritten, because a tampering attempt is itself evidence.
- **Date filters use the UTC day.** The data's offsets are Estonian time, so a Tallinn-day filter would arguably be more natural; UTC is simple and stated. The detail view shows both clocks.
- **All source hosts are under `.example`**, a reserved name that does not resolve. The links are correct and dead by design.

Full rules and per-record decisions: [DESIGN 4](docs/DESIGN.md#4-data-normalisation).

## Ambiguities

The task and the data leave several things open. Each has a recorded decision in the [ambiguities register](docs/DESIGN.md#10-ambiguities-register). The main ones:

- "Analysts search in Estonian and English" could mean the query language, inflected and compound Estonian text, or finding notes written in the other language. All three are handled, to the depth stated in [DESIGN 3.4](docs/DESIGN.md#34-what-estonian-and-english-means-here).
- "Fetch one finding by id", but two ids are not unique (T4, D2), and 30 records are re-ingested copies under new ids (T3, D3).
- The task says "username" and "pseudonym"; the data says `handle` and `alias`. The data's terms are kept and the UI labels explain them (T2).
- `list_cases` is required, but the data has nothing about a case except its id. It returns derived counts and says so (T6).
- Revision 2026-07-28 drops the handshake that most MCP clients still use. The server implements 2026-07-28 in full and also answers the old handshake without sessions (T7).
- "A link to its source", but some sources are unsafe or not URLs (T9). Time zones for display and filters are unspecified (T14).
- Type labels contradict values (D4). Notes are attached to findings at random, so a wallet can be "registered three days before the incident" (D14). Nothing records which tool or collector produced a finding (D19).
- Authentication, authorisation and audit are not mentioned; they are out of scope here, and the gap is stated (T11).

## Limitations

- The linear scan is fine into the tens of thousands of records. Beyond that, the store's three functions are where SQLite FTS5 or a search server would go.
- Estonian morphology is approximated by suffix stripping and a hand-kept glossary, not a morphological analyser.
- No phrase queries and no typo tolerance.
- Data is read once at start-up; new data needs a restart.
- No authentication or audit trail. Access control is the loopback-only network boundary.
- Clients using the 2025 handshake get a subset of that transport (no session, no standalone GET stream, no resumption, no batches). Tool calls do not need any of these.
- Rendering in a real browser is not covered by automated tests, although the logic that makes it safe is. Hence the checklist below.

## Manual browser check

With the application running, open <http://localhost:3000>:

1. With an empty search, the list shows 1002 findings, newest first, with a count per type next to each type checkbox.
2. Search `sokolaadimees`: entities `Šokolaadimees` appear with the whole name highlighted.
3. Search `ongitsus`: Estonian notes highlight `õngitsus` inside `õngitsuskampaanias`, and English "phishing" notes follow, highlighted on `phish`.
4. Search `script`, then `onerror`, then `mark`. The notes appear as literal text (`<script>alert(…)</script>`, `<img src=x onerror=…>`, `<mark>already highlighted</mark> by the scraper`). No dialog opens, and in the last one only the matched word `mark` is highlighted, not "already highlighted".
5. Open `F-10968` and `F-10748`: the source (`javascript:…`, `data:…`) is shown as text, marked "not linked: unsafe scheme".
6. Open `F-10930`: the source is a link, marked "(scheme assumed)".
7. Open `F-10578` and `F-10578-2`: two different findings (a wallet and a domain), each linking to the other under "Same id in the source".
8. Tick "show duplicates" and search `@raven-tundra`: `F-20004` appears in upper case; its detail view links to the finding it duplicates.
9. Search `ignore`: `F-10209` and `F-10661` carry the instruction-like flag, and their notes are shown unchanged.
10. The browser console shows no Content Security Policy violations. Source links point at `.example` hosts and will not load; that is expected.

## How it was built

A Fable architecture advisor wrote [docs/DESIGN.md](docs/DESIGN.md) and an internal implementation plan with exact contracts, tests and a commit list for each work package. Four Opus agents then implemented the core (normalisation, ingest, search), HTTP, MCP and UI packages in parallel, each in its own git worktree and branch. The branches were merged into `main` with `--no-ff`, so `git log --graph` shows each package's own commits. The MCP package first rejected the 2025 handshake; the stateless fallback was added after that decision was changed, and both commits are in the history. An integration agent then added `src/server.js`, the end-to-end and interoperability tests, the Docker files and this README, and brought the design document in line with the code. Nothing was squashed.
