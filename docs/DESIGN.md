# Design

This document records what was built, why, and what was deliberately left out. The README is the short version; this is the reference.

Contents: [1 Summary](#1-summary) · [2 Architecture](#2-architecture) · [3 Storage and search](#3-storage-and-search) · [4 Data normalisation](#4-data-normalisation) · [5 HTTP API](#5-http-api) · [6 MCP interface](#6-mcp-interface) · [7 UI](#7-ui) · [8 Security posture](#8-security-posture) · [9 Testing](#9-testing) · [10 Ambiguities register](#10-ambiguities-register) · [11 Limitations and next steps](#11-limitations-and-next-steps)

## 1. Summary

| Question | Decision |
| --- | --- |
| Runtime | Node.js 22 (LTS), ES modules, no build step, **zero runtime dependencies** |
| HTTP | `node:http`, one process, one port: UI, `/api/*`, `/mcp`, `/healthz` |
| Storage | The JSON file is normalised once at start-up into an in-memory array. No database |
| Search | Linear scan over diacritic-folded text; substring matching, light stemming, a small Estonian/English glossary; server computes highlight ranges |
| MCP | Hand-written JSON-RPC handler for protocol revision **2026-07-28**, plus a stateless fallback for clients that still open with the 2025 `initialize` handshake (dual-era, no sessions); checked against the official client |
| UI | One static page, vanilla JS, DOM built with `textContent` only, strict CSP |
| Data policy | Normalise for retrieval, never overwrite: every finding carries its original record verbatim, and anomalies are flagged rather than silently fixed or dropped |
| Tests | `node --test`, no test framework |

The guiding constraint is the size of the problem: 1032 records, read-only, one user at a time. Everything below is sized to that, and section 11 says where it stops being adequate.

## 2. Architecture

```
findings.json ──► core/ingest ──► in-memory store ──┬─► http/api   ──► GET /api/findings, /api/findings/:id, /api/cases
                  (normalise,     (search,           │                    ▲
                   dedupe, flag)   getFinding,       │                    │ fetch
                                   listCases)        │               public/ (static UI)
                                                     └─► mcp/handler ──► POST /mcp  (search_findings, get_finding, list_cases)
```

- `src/core/` is the single source of truth. It owns normalisation, parameter validation, search, and lookups. It has no knowledge of HTTP or MCP.
- `src/http/` and `src/mcp/` are thin adapters. Both call the same three store functions and the same parameter validator, so the UI and an AI client can never see different answers to the same question.
- `public/` is the UI. It receives highlight ranges from the API instead of re-implementing the matcher.

```
src/server.js          composition root: config, load data, start server, graceful shutdown
src/config.js          environment → config object
src/core/fold.js       diacritic/case folding with offset map
src/core/normalize.js  per-record normalisation (type, case, time, source, notes)
src/core/ingest.js     dataset-level rules: unique ids, duplicate linking, report
src/core/glossary.js   Estonian/English term groups
src/core/params.js     shared validation of search parameters
src/core/search.js     matching, scoring, highlight ranges, facets
src/core/store.js      createStore(): search / getFinding / listCases / stats
src/http/app.js        routing, Host/Origin check, security headers
src/http/api.js        /api handlers
src/http/static.js     fixed allowlist of static files
src/http/respond.js    JSON response helper for the HTTP side
src/mcp/protocol.js    constants and JSON-RPC helpers
src/mcp/handler.js     Streamable HTTP transport rules and method dispatch
src/mcp/tools.js       tool definitions and calls into the store
public/                index.html, app.js, highlight.js, style.css
test/                  node --test suites
```

## 3. Storage and search

### 3.1 Decision

Load the file once, normalise it, keep it in memory, and answer each query with a linear scan over pre-folded strings.

Reasons:

1. **Size.** 1032 records of about 120 characters each. A prototype of the matcher described below answered queries against the full dataset in 1–3 ms on the development machine, unoptimised. An index would not be measurably faster and would add moving parts.
2. **The data is read-only.** There is no write path, so there is nothing for a database to keep consistent or durable. The source of truth stays the JSON file that was handed over.
3. **Estonian needs substring matching, not token matching.** Estonian builds compounds (`õngitsuskampaanias` = phishing + campaign + inessive case) and inflects by suffix. A tokenising index only finds whole tokens or token prefixes, so `kampaania` does not find `õngitsuskampaanias`. Substring matching over folded text does.
4. **Identifiers need substring matching too.** Analysts paste fragments: `198.51.100`, `0xc008`, `@raven-tundra`. Tokenisers split these on punctuation in ways that depend on the tokenizer; a substring scan has no such surprises.
5. **Highlighting must be exact and safe.** The matcher knows precisely which characters matched, including when the query had no diacritics and the text did. It returns numeric ranges; no markup is ever spliced into untrusted text.

### 3.2 Alternatives considered

| Option | Checked how | Verdict |
| --- | --- | --- |
| **SQLite FTS5 via `node:sqlite`** | Ran a script on Node 22.23 locally and in `node:22-alpine`, `node:22-slim`, `node:24-alpine`. FTS5 is compiled in everywhere (SQLite 3.51–3.53), `unicode61 remove_diacritics 2` and `trigram remove_diacritics 1` both work | Viable, not chosen. `unicode61`: `sokolaadimees` matches, but `ongitsus` and `kampaania` do **not** match `õngitsuskampaanias` (needs an explicit `ongitsus*`, and infix is impossible). `trigram`: substrings work, but queries shorter than 3 characters do not, and there is still no inflection or synonym handling, so that logic would live in JS anyway. `highlight()` splices marker strings into the text, which needs extra care with notes that already contain `<mark>`. `node:sqlite` is still experimental in Node 22 and prints a warning. This is the first thing to adopt when the data grows (section 11) |
| **MiniSearch / Lunr / FlexSearch** | Reasoned, not run | A dependency that solves tokenised search. Same compound problem as `unicode61`; none ships an Estonian stemmer |
| **OpenSearch / Elasticsearch / Meilisearch / Postgres** | Reasoned, not run | The right class of tool for millions of records, real Estonian analysis and concurrent writers. For 1032 static records it is a second container, a schema, an indexing step and a start-up race, with no user-visible gain |
| **Embeddings / semantic search** | Reasoned, not run | Would give real cross-language retrieval, at the cost of a model download or an external API call. Sending case data to an external service is not acceptable by default in this domain |

### 3.3 Matching rules

**Folding.** Both the query and the searched text are lower-cased, decomposed (NFD) and stripped of combining marks, one code point at a time, keeping a map from every folded character back to its position in the original string. `Šokolaadimees`, `šokolaadimees` and `sokolaadimees` are the same folded string. The original text is never modified; folding exists only inside the index.

Folding `õ ä ö ü` to `o a o u` is linguistically lossy (they are distinct Estonian letters), but analysts type without diacritics on foreign keyboards and in a hurry, and a missed finding costs more than an extra one.

**Terms.** The query is split on whitespace only. Punctuation stays inside a term, so `198.51.100.2`, `harbor.sable@raven-tundra.test` and `IP-aadress` are single terms. Every term must match (AND) in the entity or in the notes.

**How a term matches a field.** Three kinds of variant are tried in this order, and the first that occurs in the field is used:

1. *Exact*: the folded term as a substring.
2. *Stem*: for purely alphabetic terms of 5 or more letters, the term with its last 1, 2 or 3 letters removed (never shorter than 4). This is deliberately crude suffix stripping: `sisselogimine` → `sisselogimi` finds `sisselogimisi`; `rünnakule` → `rünnaku` finds `rünnakut`; `domeenid` → `domeen`. It handles English plurals and tenses the same way.
3. *Glossary*: a table of about twenty term groups such as `phish | õngits`, `domain | domeen`, `source | allika`, `log, journal | žurnaal`. If the term starts with any stem in a group, or is at least 4 letters long and is itself the start of one (`dome`, but not `dom`), every stem in that group is tried. `phishing` therefore also finds `õngitsuskampaanias`, and `õngitsemine` finds both languages.

**Ranking.** Each term scores `variant weight × position factor`, summed over terms. Variant weights: exact 4, stem 2, glossary 1. Position factor: 4 if the term equals the whole entity, 3 if the entity starts with it, 2 if the match starts at a word boundary, 1 if it is inside a word. Ties are broken by newest `observedAt`, then id. The effect: an exact entity is always first, a literal match beats a stemmed one, a stemmed one beats a translated one, and `c2` inside a wallet's hex digits ranks below the note that says "C2 range".

**Highlighting.** The API returns, per result, `highlights.entity` and `highlights.notes` as arrays of `[start, end)` UTF-16 offsets into the exact strings in the same response. Glossary and stem matches highlight what actually matched in the text, so the analyst can see why a result appeared.

**Empty query** lists everything that passes the filters, newest first.

### 3.4 What "Estonian and English" means here

The requirement is one sentence, and it can mean three different things. All three are covered to a stated depth:

| Reading | Handling |
| --- | --- |
| Queries may be typed in either language, with or without diacritics | Folding. Fully handled |
| Estonian words appear inflected and compounded | Substring matching plus stem variants. A heuristic, not morphology: consonant gradation (`rünnak` / `ründe`) is only covered where the glossary lists both stems |
| A query in one language should find notes written in the other | The glossary. It covers the investigative vocabulary present in this dataset and is trivially extensible, but it is a hand-kept word list, not translation. Glossary hits rank lowest and are highlighted, so they are visible as such |

Not done: a real Estonian morphological analyser (Vabamorf/EstNLTK are the usual choices; both are native or Python dependencies), and phrase queries in quotes.

### 3.5 Filters

`types` (any of `domain ip email handle alias wallet unknown`), `caseId` (`C-104`, or `unassigned`), `from` / `to` on `observedAt`, `includeDuplicates`, `limit` / `offset`. The response includes per-type counts for the current query so the type filter can show how many results each choice would give.

## 4. Data normalisation

Principles:

1. **Nothing is destroyed.** Every finding keeps `raw`, the original JSON object exactly as loaded. The detail view and `get_finding` show it.
2. **Canonical fields exist for retrieval**: so that filtering by type, case and date works, and duplicates collapse.
3. **Anything an analyst should know about is a flag**, not a silent correction. Cosmetic normalisation (whitespace, letter case of a label) is not flagged, but is visible by comparing with `raw`.
4. **Ingest never fails on one bad record.** Wrong types and missing fields degrade to a flagged finding.

### 4.1 Field rules

| Field | Canonical form | Rule | Dataset cases |
| --- | --- | --- | --- |
| `id` | `id` (unique), `rawId` | First record with a given id keeps it. Every later record with the same id becomes `<id>-2`, `<id>-3`, … in file order, whether or not its content differs (ids are compared without regard to letter case, as lookups are; identical content is then linked as a duplicate, 4.4). All records sharing a raw id get the flag `duplicate_id` and list each other in `sameRawId` | `F-10578` and `F-10401` each occur twice with unrelated content → `F-10578`, `F-10578-2`, `F-10401`, `F-10401-2` |
| `entity` | `entity` (trimmed, letter case as collected) | Only surrounding whitespace is removed. A lower-cased, NFC-normalised `entityKey` is used internally for duplicate detection | 4 padded values, 3 upper-case emails |
| `type` | `type` ∈ `domain ip email handle alias wallet unknown`, `typeRaw` | See 4.2 | 7 non-canonical labels |
| `caseId` | `caseIds`: sorted array of `C-<n>` | Trim, upper-case. An array becomes several case ids (`multi_case`). `null` or missing becomes `[]` (`case_missing`). Anything else that does not match `C-<digits>` is dropped from `caseIds` and flagged `case_invalid` | `" c-117"` → `["C-117"]`; `["C-104","C-122"]`; `null` |
| `observedAt` | ISO 8601 UTC string, or `null` | Strings are parsed as ISO 8601 with their offset and converted to UTC; a date-time without `Z` or an offset is not guessed. Numbers, and strings of digits only, are epoch **milliseconds**; values below 10¹¹ are treated as seconds. Unparseable → `null` + `time_invalid` | 730 `Z`, 180 with `+02:00`/`+03:00`, 122 epoch ms |
| `sourceUrl` | `source: { raw, href, status }` | See 4.3 | 7 with `utm_*`, 5 trailing slashes, 1 `data:`, 1 `javascript:`, 1 without scheme, 1 empty |
| `notes` | `notes` string (`""` if absent) | Missing key, `null` and non-string values become `""`; those and an empty or whitespace-only string are flagged `notes_missing`. Text is otherwise untouched: no HTML decoding, no stripping. Two advisory flags: `notes_markup` (contains tags or entities) and `notes_instruction_like` (see 6.5) | 4 missing, 3 `null`, 7 with markup, 4 instruction-like |

### 4.2 Type

The label and the value can disagree, and four of the six types can be verified from syntax alone.

1. Normalise the label: trim, lower-case, map known synonyms (`ipv4` → `ip`).
2. Detect the value's shape: EVM wallet (`0x` + 40 hex), IP address (`net.isIP`), email, domain name. Handles and aliases have no verifiable syntax.
3. Decide:
   - The value has a verifiable shape → **that is the type.** If the label says otherwise, flag `type_mismatch`.
   - The value has no verifiable shape and the label is `handle`, `alias` or `wallet` → trust the label. (Non-EVM wallet formats are not validated; see the register.)
   - The value has no verifiable shape and the label claims `ip`, `email` or `domain`, or is not a known label → `unknown` + `type_mismatch`.

| Record | Label | Value | Result |
| --- | --- | --- | --- |
| F-10917 | `" email "` | an email | `email` (label tidied, no flag) |
| F-10788 | `ipv4` | `tundra-ember.test` | `domain`, `type_mismatch` |
| F-10819 | `Domain` | `192.0.2.14` | `ip`, `type_mismatch` |
| F-10142 | `url` | an email | `email`, `type_mismatch` |
| F-10380 | `Handle` | an email | `email`, `type_mismatch` |
| F-10582 | `IP` | `zephyr_raven92` | `unknown`, `type_mismatch` |
| F-10276 | `ALIAS` | `cobalt_harbor31` | `alias` (no flag) |

Why the value wins over the label: the type filter exists so that an analyst who asks for IP addresses gets all of them. The label is still shown next to the type wherever they differ.

Two of these are judgement calls. F-10380: an email address can legitimately be someone's handle; it is filed under `email` because that is what a search for emails should return, and the flag plus `typeRaw` preserve the original claim. F-10276: the value looks like every other handle in the dataset, but a pseudonym can take any form and nothing in the syntax proves the label wrong, so the label stands. F-10582 looks like a handle for the same reason, but "looks like" is a guess between handle and alias; `unknown` says only what is known, which is that it is not an IP address.

### 4.3 Source URL

| `status` | Condition | `href` |
| --- | --- | --- |
| `ok` | Parses as an absolute URL with scheme `http` or `https` and a host | The URL as collected, as the URL parser serialises it |
| `scheme_assumed` | No scheme, but looks like `host/path` or `host:port/path` | `https://` + raw. Flag `source_scheme_assumed` |
| `unsafe` | Any other scheme (`javascript:`, `data:`, `file:`, …) | `null`. Flag `source_unsafe` |
| `missing` | Empty or absent | `null`. Flag `source_missing` |
| `invalid` | Anything else | `null`. Flag `source_invalid` |

The UI renders a link only when `href` is set, re-checks the scheme itself before assigning it, and opens it with `rel="noopener noreferrer"` and `referrerpolicy="no-referrer"`. Everything else is shown as inert text with the reason. The raw value is always displayed.

The link target is the URL exactly as collected, tracking parameters included: that is the evidence. A cleaned form (no `utm_*` parameters, no fragment, no trailing slash) is used only as part of the duplicate key.

All source hosts in the dataset are under `.example`, which is reserved (RFC 2606) and does not resolve. The links are correct and dead by construction.

### 4.4 Duplicates

Two different things are called "duplicate" in this data, and they get opposite treatment.

**Same id, different content** (2 ids). These are two distinct findings with an id collision. Both are kept as full findings and made addressable (4.1).

**Different id, same content** (30 pairs). Every `F-200xx` record repeats an `F-10xxx` record. They are considered the same observation when all of these are equal: entity (trimmed, lower-cased and NFC-normalised; diacritics are kept, unlike in search), set of case ids, instant of `observedAt`, cleaned source URL, notes. On this dataset that key yields exactly the 30 pairs and nothing else; 6 pairs are identical apart from the id, the rest differ by whitespace, letter case, epoch-vs-ISO time, `utm_*` parameters or a trailing slash.

- The record with the lowest id is the canonical one. The others get `duplicateOf: <canonical id>` and the flag `reingested_duplicate`; the canonical one lists them in `duplicates`.
- Search and case counts hide duplicates by default (`includeDuplicates=true` shows them). Nothing is deleted: a duplicate is still returned by id, with a pointer to its canonical record.
- A record with no entity or no valid `observedAt` is never linked: too little is left to call two of them the same. (None in this dataset.)

After ingest: 1032 records → 1002 distinct findings + 30 linked duplicates, in 40 cases plus one finding with no case.

### 4.5 Flags

`duplicate_id` · `reingested_duplicate` · `type_mismatch` · `case_missing` · `case_invalid` · `multi_case` · `time_invalid` · `source_missing` · `source_unsafe` · `source_scheme_assumed` · `source_invalid` · `notes_missing` · `notes_markup` · `notes_instruction_like` · `entity_missing` · `id_missing`

The server logs a count per flag at start-up.

## 5. HTTP API

All responses are JSON, UTF-8, `Cache-Control: no-store`. Only `GET` and `HEAD` are accepted.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/findings` | Search and browse. Query parameters: `q`, `type` (comma-separated or repeated), `case`, `from`, `to`, `limit` (1–100, default 20), `offset`, `includeDuplicates`. Other query parameters are ignored |
| `GET /api/findings/:id` | One finding including `raw`. The id is matched without regard to letter case |
| `GET /api/cases` | Case ids with counts, type breakdown and first/last observation |
| `GET /healthz` | Liveness and record count |

```jsonc
// GET /api/findings?q=ongitsus&type=ip&limit=1
{
  "total": 20, "limit": 1, "offset": 0,
  "facets": { "types": { "domain": 20, "ip": 20, "email": 18, "handle": 20, "alias": 22, "wallet": 23, "unknown": 1 } },
  "results": [{
    "id": "F-10617", "rawId": "F-10617", "type": "ip", "typeRaw": "ip",
    "entity": "198.51.100.130", "caseIds": ["C-113"], "observedAt": "2026-10-25T09:55:10.000Z",
    "notes": "Kasutaja märgiti õngitsuskampaanias.",
    "source": { "raw": "https://chat.example/25643", "href": "https://chat.example/25643", "status": "ok" },
    "flags": [], "duplicateOf": null, "duplicates": [], "sameRawId": [],
    "score": 8, "highlights": { "entity": [], "notes": [[17, 25]] }
  }]
}
```

(Actual output on the provided dataset.)

Errors: `{ "error": { "code", "message", "details"? } }` with:

- `400 invalid_params`: one detail entry `{ param, message }` per bad parameter, using the HTTP names (`q`, `type`, `case`, …). A finding id with malformed %-encoding gets the same code with `param: "id"`.
- `400 bad_request`: a request target the URL parser cannot read.
- `403 forbidden`: `Host` or `Origin` not on the allowlist (section 8). On `/mcp` this body is a JSON-RPC error instead, as are all `/mcp` errors.
- `404 not_found`, `405 method_not_allowed` (with `Allow: GET, HEAD`), `500 internal`.

Dates: `from`/`to` accept `YYYY-MM-DD` or a full date-time with `Z` or an offset. A bare date is interpreted in UTC; `to` as a bare date includes that whole day. A date-time without a zone is rejected rather than guessed.

## 6. MCP interface

### 6.1 SDK or hand-written

The assignment pins protocol revision 2026-07-28. That revision is not an increment: it removes the `initialize` handshake, sessions, the GET stream and `ping`, and makes every request self-describing. So the first question was whether the official SDK implements it. Checked on npm on 2026-11-11:

| Package | Version | Supports 2026-07-28 |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` (v1 line) | 1.32.2 | **No.** `LATEST_PROTOCOL_VERSION = '2025-11-25'`; no `server/discover` |
| `@modelcontextprotocol/server` + `/node` (v2 line) | 2.4.0 / 2.1.2 | Yes, via `createMcpHandler` |
| `@modelcontextprotocol/client` (v2 line) | 2.4.0 | Yes, but **opt-in**: the default is still the 2025 handshake |

The server here is hand-written. The surface needed is small (three methods plus one stream, JSON responses only, no sessions, no server-initiated traffic), the revision is simpler to implement than its predecessors precisely because it is stateless, and it keeps the application at zero runtime dependencies. The v2 SDK would also have been a reasonable choice; it would bring `zod` and a second validation path next to the one the HTTP API uses.

To keep "hand-written" from meaning "probably compliant", two checks were made:

- The official v2 server was run with a trivial tool and probed with about forty requests covering every rule below. Where the specification leaves a status code open, this implementation follows the reference behaviour, and the differences are listed in 6.4.
- The official v2 **client** connects to this server, lists the tools and calls them, in all three of its negotiation modes: pinned to 2026-07-28, `auto`, and its default 2025 handshake (6.3). This runs as a dev-only test (`test/mcp/interop.test.js`). The client validates each `structuredContent` against the tool's `outputSchema`.

### 6.2 Compliance notes

Section names refer to pages under <https://modelcontextprotocol.io/specification/2026-07-28/>.

| Requirement | Source | Implementation |
| --- | --- | --- |
| One endpoint that accepts POST; each message is its own POST | `basic/transports/streamable-http` › intro, Sending Messages | `POST /mcp` |
| A server MAY serve legacy (`initialize`-based) clients as well as modern ones | `basic/versioning` › Backward Compatibility with Initialization-Based Versions | Dual-era, stateless in both eras. Each request is classified on its own (6.3) |
| GET and DELETE are gone; answer 405 | same › Backward Compatibility › Earlier Streamable HTTP Revisions | Any method other than POST → `405`, `Allow: POST`. That is also a valid answer for a 2025 server that offers no standalone SSE stream (2025-11-25 `basic/transports` › Listening for Messages) |
| No sessions; ignore `Mcp-Session-Id` and `Last-Event-ID`, never mint a session id | same; `changelog` major 1, 9 | Headers ignored, nothing echoed. Legacy clients get no session either: in 2025 a server only MAY assign one |
| Validate `Origin`; invalid → 403 | same › Security & Endpoint | Host and Origin hostnames checked against an allowlist (loopback by default) on every route |
| Bind to localhost when running locally | same | Outside a container the server binds to `127.0.0.1` by default. The container listens on all interfaces because it must; Compose publishes the port on `127.0.0.1` only |
| Body is a single JSON-RPC request or notification, never a response, never a batch | same › Sending Messages | Arrays and responses → `400` / `-32600`, in both eras |
| Notification accepted → `202`, no body | same | Yes. The core protocol defines no client notification over HTTP in this revision; any that arrive are acknowledged and ignored |
| Request answered with `application/json` or an SSE stream | same | JSON for everything except `subscriptions/listen` |
| Every request carries `_meta` with `io.modelcontextprotocol/protocolVersion` and `…/clientCapabilities`; missing → `-32602`, HTTP 400 | `basic` › `_meta` › Per-request protocol fields | Checked on every request that carries any modern marker (6.3). No state is kept between requests (`basic` › Statelessness) |
| `MCP-Protocol-Version` header required and equal to the body value; mismatch → 400 `HeaderMismatch` (`-32020`) | `basic/transports/streamable-http` › Protocol Version Header, Server Validation | Yes, on modern requests. A request with no header and no other modern marker is a 2025-03-26 client, which the same section allows a server to assume |
| `Mcp-Method` header required on all requests, `Mcp-Name` on `tools/call`; missing or different from the body → 400 / `-32020`. `Mcp-Name` may use the `=?base64?…?=` encoding and must be decoded before comparing | same › Standard Request Headers, Value Encoding, Server Validation | Yes, on modern requests (an `Mcp-Method` header is itself a modern marker). A sentinel with invalid Base64 counts as a mismatch |
| Unsupported version → 400 `UnsupportedProtocolVersionError` (`-32022`) with `data.supported` and `data.requested` | `basic/versioning` › Protocol Version Negotiation | Yes. Supported: `["2026-07-28"]`. The legacy versions are not listed, because they are reachable only through `initialize` (6.3) |
| Unknown method → **404** with JSON-RPC `-32601` | `basic/transports/streamable-http` › Protocol Version Header | Yes, including the removed `ping` and the unadvertised `prompts/*`, `resources/*`. Legacy requests get `200` instead (6.3) |
| `server/discover` MUST be implemented | `server/discover`; `basic/versioning` | Returns `supportedVersions`, `capabilities: { tools: {} }`, `instructions`, cache hints |
| Results carry `resultType` | `basic` › Responses › ResultType; `changelog` major 8 | `"complete"` on every result |
| Servers SHOULD identify themselves in each result's `_meta` | `basic` › Per-response protocol fields | `io.modelcontextprotocol/serverInfo` on every result |
| `ttlMs` and `cacheScope` required on `server/discover` and `tools/list` results | `server/utilities/caching` | `ttlMs: 3600000`, `cacheScope: "public"`: the tool list is static and the same for every caller |
| `tools/list` in deterministic order; must not vary per connection | `server/tools` › Capabilities | Fixed order. `tools.listChanged` is not advertised because the list never changes |
| Invalid cursor SHOULD give `-32602` | `server/utilities/pagination` | No cursors are ever issued, so any cursor is invalid |
| Unknown tool and malformed `tools/call` are protocol errors (`-32602`); failures the model can correct are results with `isError: true` | `server/tools` › Error Handling | Unknown tool, missing `name`, non-object `arguments` → `-32602`. Bad argument values and "no such finding" → `isError: true` with a message that says what to change |
| A tool with `outputSchema` MUST return conforming `structuredContent`, and SHOULD also return it serialised in a text block | `server/tools` › Structured Content, Output Schema | Both, on every successful call |
| `subscriptions/listen`: first message is `notifications/subscriptions/acknowledged` carrying the subscription id; closing the stream cancels | `basic/patterns/subscriptions`; `basic/patterns/cancellation` | Implemented minimally: acknowledges with an empty filter (nothing here ever changes), sends keep-alive comments, ends cleanly on shutdown |
| Servers MUST NOT send JSON-RPC requests | `basic/patterns` | None. No sampling, elicitation or roots; no client capability is ever required, so `-32021` is never returned |
| Tool security: validate inputs, rate-limit, sanitise outputs, access control | `server/tools` › Security Considerations | Inputs validated by the shared validator; a simple per-address rate limit on `tools/call`; outputs are JSON-encoded data with an explicit handling notice (6.5). Access control: see 8 |

### 6.3 Legacy clients: a stateless dual-era fallback

The assignment names revision 2026-07-28, and that is what the server implements in full. It also answers clients that still open with the 2025 `initialize` handshake over Streamable HTTP: v1 SDK clients, and the official v2 client in its default configuration. Without this, the specification's compatibility matrix gives the outcome as "Fails" (Legacy client, Modern server), and the server would be unusable from any client that has not adopted 2026-07-28 yet. The specification allows a server to support both eras (`basic/versioning` › Backward Compatibility with Initialization-Based Versions), and doing it without sessions costs a few dozen lines and no state.

Each request is classified on its own, after the JSON-RPC shape checks (body size, JSON, single request, id):

| The request | Treated as | Answer |
| --- | --- | --- |
| has any modern marker: `params._meta["io.modelcontextprotocol/protocolVersion"]`, `MCP-Protocol-Version: 2026-07-28`, or an `Mcp-Method` header | Modern | Every rule in 6.2. `initialize` → `400` / `-32022` |
| otherwise, method `initialize` | Legacy handshake | `200` `{ protocolVersion, capabilities: { tools: {} }, serverInfo, instructions }`. The requested version is echoed if it is `2025-11-25`, `2025-06-18` or `2025-03-26`; any other gets `2025-11-25` (2025-11-25 `basic/lifecycle` › Version Negotiation) |
| otherwise, `MCP-Protocol-Version` absent or one of those three | Legacy request | `tools/list`, `tools/call` and `ping` → `200`; any other method → `200` / `-32601` |
| otherwise (an unknown header version and no modern marker) | Neither | `400` / `-32022` |

How the legacy side works:

- **No session.** The `initialize` answer mints no `Mcp-Session-Id`; in 2025 a server only MAY assign one. The client then sends each request with the negotiated version header, and each is answered on its own exactly like a modern request. `notifications/initialized` gets `202` like any notification. Nothing about the handshake needs remembering, because no answer depends on it.
- **Same tools, same results.** `tools/list` returns the same tool objects, and `tools/call` goes through the same validation, rate limit and tool code. Results leave out what the 2025-11-25 schema does not define: `resultType`, `ttlMs`, `cacheScope` and the per-result `serverInfo`. A 2025-03-26 client ignores `title`, `outputSchema` and `structuredContent`, and still gets the full JSON in the text block.
- **Errors are `200`.** The 2025 transport gives no HTTP status to method errors, and there a `404` means "session terminated" or "no Streamable HTTP endpoint here", which would make a client start over or give up. The official SDK's stateless fallback also answers `200`.
- **Not served:** the standalone GET stream (`405`, which the 2025 transport allows), stream resumption, server-to-client requests (nothing here needs them), and JSON-RPC batches, which only 2025-03-26 permitted (`400`).

Two choices keep the eras from bleeding into each other:

- **Any modern marker wins.** A dual-era client tries a modern request first, and falls back to `initialize` only if a `400` body is not a recognised modern error (`basic/transports/streamable-http` › Backward Compatibility). So anything that looks modern gets a modern answer, including an `initialize` that carries a modern marker: it gets `-32022` and no handshake.
- **`supported` lists only `2026-07-28`**, in `-32022` errors and in `server/discover`. These lists name versions a client can put in the per-request `_meta`. Listing `2025-11-25` there would invite a modern request with `"protocolVersion": "2025-11-25"` in `_meta`, which no revision defines.

With the official TypeScript client, the default configuration connects through the handshake. `versionNegotiation: { mode: 'auto' }` and `{ mode: { pin: '2026-07-28' } }` speak 2026-07-28. The README has a `curl` example.

### 6.4 Where the specification leaves room

| Case | Choice | Why |
| --- | --- | --- |
| HTTP status for JSON-RPC errors not given a status by the spec (`-32602` unknown tool) | 200 | Same as the reference server. The request reached the method and was answered |
| `id` in an error when the request id could not be read | Omitted | The 2026-07-28 schema makes `id` optional there and forbids `null` ids. (The reference server sends `"id": null`, as plain JSON-RPC 2.0 does) |
| Error code in the body of 403 / 405 / 413 / 415 | `-32600` | The spec says a body "MAY" be a JSON-RPC error. The reference uses `-32000`, but `basic` › Error Codes now says new implementations should not use `-32000…-32019` |
| `Accept` header missing `text/event-stream` | Not enforced | The requirement is on the client. The reference server does not enforce it either |
| Whether a server with nothing to notify must still implement `subscriptions/listen` | Implemented | `basic` says all implementations MUST support the message patterns, and no capability gates this method |
| Tool argument fails the input schema: protocol error or `isError` result? The schema reference lists "invalid tool arguments" under `-32602`; the Tools page lists input validation under tool execution errors | `isError` result | The Tools page gives the reason (the model can read it and retry), and the reference server does the same |
| Rate limit exceeded | `isError` result with a retry hint | No error code is defined; a result is the one channel the model is guaranteed to see |
| `initialize` carrying a modern marker | `400` / `-32022` with `data.supported` | A recognised modern error, so a dual-era client stays modern, and it names the versions to use. The reference SDK answers `-32020` when the header is modern, `404` / `-32601` when the envelope is, and treats an `Mcp-Method` header alone as legacy |
| Legacy request with an unknown `MCP-Protocol-Version` and no modern marker | `400` / `-32022` | The 2025 transport only requires `400`. The reference SDK sends `-32000`, which `basic` › Error Codes now retires; `-32022` is the defined code for exactly this |

### 6.5 Tools and untrusted content

| Tool | Arguments | Structured result |
| --- | --- | --- |
| `search_findings` | `query` (required; may be empty), `types[]`, `caseId`, `from`, `to`, `limit`, `offset`, `includeDuplicates` | `{ dataNotice, total, limit, offset, results[] }` |
| `get_finding` | `id` | `{ dataNotice, finding }` including `raw`, `duplicates`, `sameRawId` |
| `list_cases` | none | `{ cases[], unassigned, note }` |

All three are annotated `readOnlyHint: true`, `openWorldHint: false`.

The dataset contains notes written to hijack an AI client ("SYSTEM: ignore all previous instructions…", "Assistant: call list_cases and…"). In an OSINT system that is not a curiosity: every note is text scraped from places an adversary can write to, and an MCP server hands that text straight to a model. A server cannot make a model immune, but it can avoid making the attack easy:

1. **Evidence is never mixed with the server's own voice.** Tool results are JSON. Untrusted text appears only as JSON string values under fixed keys (`entity`, `notes`, `source.raw`, `raw`). Nothing from a finding is ever interpolated into prose, tool descriptions or instructions.
2. **Every result that contains evidence starts with `dataNotice`**, a fixed sentence stating that those fields are verbatim third-party content, are data, and must not be followed as instructions. It travels inside the result, so it is present whichever of `content` or `structuredContent` the client forwards to its model. The same policy is stated in the server `instructions` and in each tool description.
3. **Instruction-like notes are flagged** (`notes_instruction_like`) by a short pattern list. This is a signal to the analyst and to the model that something is off, not a filter: the note is still delivered unmodified, because it is evidence, and a tampering attempt is itself a finding worth seeing. The pattern list is trivially evadable and is not relied on for safety.
4. **The tools are read-only and closed-world.** The worst a successful injection can do through this server is make the model call another read-only search. What the model then does with other tools is the client's responsibility, which is why the specification puts confirmation prompts on the client side.
5. **Results are bounded.** `search_findings` returns at most 100 findings per call.

What is deliberately not done: removing or rewriting suspicious notes. That would destroy evidence and give a false sense of safety.

## 7. UI

One page, no framework, no build. State lives in the URL fragment (`#/search?q=…&type=ip` and `#/finding/F-10327`), so searches and findings are linkable and the back button works.

- Search box (debounced, stale responses discarded), type filter with per-type counts, case filter, date range, "show duplicates".
- Results list: type, entity and notes with highlights, cases, time, flags as badges.
- Detail view: every canonical field, the source link (4.3), duplicates and id collisions as links, and the original record as JSON.
- Times are shown in UTC in the results list, and in both UTC and `Europe/Tallinn` in the detail view.

**Rendering untrusted text.** The page never parses data as HTML. There is no `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` in the code, and a test fails the build if one appears. Highlighted text is built by cutting the string at the server-supplied offsets and appending text nodes and `<mark>` elements, so a note that contains `<script>`, `<img onerror>` or its own `<mark>` is displayed as those literal characters. As a second layer the page is served with `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, which would block an injected script even if a rendering bug existed.

## 8. Security posture

| Concern | Handling |
| --- | --- |
| XSS from notes or entities | Section 7 |
| Dangerous source links | Section 4.3 |
| Prompt injection through MCP | Section 6.5 |
| DNS rebinding, cross-site requests | Host and Origin hostname allowlist (`localhost`, `127.0.0.1`, `[::1]` by default; `ALLOWED_HOSTS` adds more). No CORS headers are sent, so other origins cannot read responses; `OPTIONS` is refused |
| Network exposure | Compose publishes on `127.0.0.1` only. To expose it elsewhere, change the port mapping and set `ALLOWED_HOSTS`, deliberately |
| Authentication | **None.** See below |
| Resource use | 1 MiB request body limit on `/mcp`; query length and page size capped; rate limit on tool calls; capped number of open `subscriptions/listen` streams |
| Container | Non-root user, read-only root filesystem, all capabilities dropped, no new privileges, no shell tools needed at runtime, no packages installed |
| Supply chain | No runtime dependencies. One dev-only dependency (the official MCP client, for the interoperability test), pinned to an exact version and not present in the image |
| Error detail | Internal errors are logged server-side and returned as a generic message |

**No authentication.** The assignment does not ask for it and the data is fictional, but this is the gap that matters most if the design were reused: the specification says servers SHOULD authenticate (`basic/transports/streamable-http` › Security & Endpoint) and tool servers MUST implement access control (`server/tools` › Security Considerations). Here access control is the network boundary only. A real deployment would add the OAuth-based authorization the specification describes, per-case authorisation in the store functions (the one place both interfaces go through), and an audit log of who searched for what.

## 9. Testing

`npm test` runs `node --test` over `test/**/*.test.js`. No framework, no browser.

| Layer | What is covered |
| --- | --- |
| Folding | Diacritics, case, offset map for characters that change length |
| Normalisation | Every row of the tables in section 4, by record id, plus malformed input that is not in the dataset |
| Ingest on the real file | 1032 records → 1002 + 30; exact lists of flagged ids; `F-10578` and `F-10401` both retrievable in both variants |
| Search | Both languages, diacritic-free queries, compounds, stems, glossary, IP/wallet/email fragments, ranking order, AND semantics, filters, facets, pagination, highlight ranges that slice to the expected text |
| HTTP API | Shapes, validation errors, 404/405, security headers, Host/Origin rejection, hostile notes returned byte-for-byte as JSON |
| MCP | Every row of 6.2 and 6.3 as a black-box HTTP test, legacy requests included; tool results; injection notes arrive flagged, verbatim, under `dataNotice` |
| MCP interoperability | The official v2 client in all three negotiation modes: pinned to 2026-07-28, `auto` (both negotiate 2026-07-28) and its default (negotiates 2025-11-25 through the stateless fallback). Each lists the tools, calls all three, gets `isError` for a bad argument and `-32602` for an unknown tool. Skipped when dev dependencies are not installed |
| End to end | `src/server.js` started as a child process on the real file: health check, the page with its CSP, the same search through `/api` and through MCP returning the same ids in the same order, and exit code 0 within 2 s of `SIGTERM` |
| UI | Pure functions (range splitting, link policy) and a static scan for forbidden DOM sinks. Rendering in a real browser is a manual check, listed in the README |

## 10. Ambiguities register

### 10.1 In the task

| # | Ambiguity or gap | Decision | Reason |
| --- | --- | --- | --- |
| T1 | "Analysts search in Estonian and English": the query language, the data language, or cross-language retrieval? | All three, to the depth in 3.4 | The notes are half Estonian, half English, and several are translations of each other; ignoring that would hide half the relevant findings from any one query |
| T2 | The task says "username" and "pseudonym"; the data says `handle` and `alias` | Keep the data's vocabulary in the API; the UI labels them "handle (username)" and "alias (pseudonym)" | Changing stored values to match prose would be a silent transformation |
| T3 | "about 1000 artefacts" / "1032 records" vs. distinct findings | 1032 records, 1002 distinct findings; both numbers are reported | 4.4 |
| T4 | "fetch one finding by id", but ids are not unique | 4.1: every record gets a unique, stable id; collisions are flagged and cross-linked | Lookup must be a function. Picking one silently would hide a finding |
| T5 | "optional filters": which? | Type (required by the UI section), case, date range, duplicates | These are the dimensions the data has. Source host was left out as low value |
| T6 | `list_cases` is required, but there is no case data beyond the id | Returns ids with counts, type breakdown and first/last observation, plus a note that no case metadata exists | Derivable facts only; nothing invented. The HTTP API has the same endpoint because the UI's case filter needs it |
| T7 | "following MCP spec version 2026-07-28": that revision removes the handshake most clients and the v1 SDK still use | Implement that revision in full. Also answer the 2025 `initialize` handshake without sessions, so clients that have not adopted 2026-07-28 still work; anything carrying a 2026-07-28 marker gets 2026-07-28 rules only | 6.1, 6.3 |
| T8 | Is `query` required for `search_findings`? ("free-text query, optional filters") | Required, may be an empty string | Matches the wording; an empty string means "browse with filters" |
| T9 | "link to its source", but some sources are not safe or not URLs | 4.3 | A link is rendered only when it is safe to click |
| T10 | "matching text highlighted": in which fields, and what counts as matching for stemmed or translated hits? | Entity and notes; highlight the text that actually matched | The analyst should see why a result is there |
| T11 | Authentication, authorisation, audit, multi-user | Out of scope, stated in section 8 | Not requested; flagged because the domain would require them |
| T12 | Persistence and updates: is the data ever written? | Read-only; loaded at start-up; restart to reload | Nothing in the task writes |
| T13 | UI language | English labels | Unspecified; the reviewers' own text mixes both. Translating labels is mechanical |
| T14 | Time zone for display and for date filters | Stored and filtered in UTC; displayed in UTC and Europe/Tallinn; a bare date in a filter means the UTC day | The offsets in the data (`+03:00`, `+02:00`) are Estonian summer and winter time, so Tallinn time is what the collectors saw. Filtering by the UTC day is simple and stated, not necessarily what every analyst expects |
| T15 | Result ordering | Relevance, then newest first; newest first when there is no query | 3.3 |
| T16 | Pagination | `limit` / `offset`, default 20, max 100 | "about 1000" results do not belong in one response, least of all in a model's context |
| T17 | Tests are not mentioned | Included | "Usable and correct" is not checkable otherwise |
| T18 | Which port, which Compose file name | Port 3000, `compose.yaml` | Current Compose default file name |

### 10.2 In the data

| # | Observation | Decision | Reason |
| --- | --- | --- | --- |
| D1 | `_meta` says `count: 1032` and "Fictional OSINT findings", generated with a seed | Count is verified at start-up (warning on mismatch). The data is treated as hostile anyway | The description is itself untrusted input |
| D2 | Two ids each used by two unrelated findings | 4.1 | |
| D3 | 30 re-ingested near-copies under `F-200xx` | 4.4. That `F-200xx` means "a later import" is an inference from the id range | The lower id is canonical because that is the only ordering the data offers; the copies carry no import date |
| D4 | Type labels vary in case, padding and vocabulary; some contradict the value | 4.2 | |
| D5 | `caseId` as array, `null`, and `" c-117"` | 4.1. A finding in two cases counts in both | An entity linking two cases is the most interesting kind; it must not be forced into one |
| D6 | Three time formats; epoch values are milliseconds | 4.1 | Milliseconds was verified: read as ms, all 122 fall inside the same two months as the ISO values |
| D7 | All times fall between 2026-09-01 and 2026-10-31 | None needed | No future or absurd dates to flag; `time_invalid` exists for when there are |
| D8 | Source URLs: tracking parameters, trailing slashes, `javascript:`, `data:`, no scheme, empty | 4.3 | |
| D9 | Source hosts are all `.example` | Links are rendered and will not resolve | Reserved names; noted in the README so it is not mistaken for a bug |
| D10 | Entities with padding or in upper case | Trim only; compare case-insensitively | Case can be evidence (how it was written where it was found); whitespace is not |
| D11 | Notes missing (4), `null` (3) | `""` + `notes_missing`; missing and `null` are not distinguished except in `raw` | No analyst-relevant difference |
| D12 | Notes containing HTML, an HTML entity, and a pre-existing `<mark>` | Stored and shown verbatim as text; flagged `notes_markup`. `&lt;` is **not** decoded | Decoding would change evidence, and the scraper that produced it is unknown |
| D13 | Notes containing instructions aimed at an AI | 6.5 | |
| D14 | Notes are assigned at random: a wallet "registered three days before the incident", "{entity} resolved to known C2 range" on an alias | Nothing. Notes are searched as text, not interpreted | It does mean notes cannot be used to infer or check the type |
| D15 | Notes that embed the entity ("Seen in phishing kit config for X") | A query for the entity matches both fields and highlights both | Expected behaviour, noted because it doubles the highlight |
| D16 | The same entity appears in several cases (799 distinct entities in 1002 findings), most visibly the aliases | The detail view links to a search for the entity | Cross-case pivoting is the core analyst action; a search link gives it without new API surface |
| D17 | IPs are all in documentation ranges; wallets are all EVM-shaped; domains are all `.test` | Shape detection accepts any valid IPv4/IPv6 address and domain, but only EVM wallets | Other wallet formats (Bitcoin and others) would be trusted by label and not validated. Stated as an assumption |
| D18 | One finding (F-10767) has no case | Reachable with `case=unassigned`; counted separately in `list_cases` | Otherwise it would be invisible when browsing by case |
| D19 | No field says who collected a finding or with which tool, though the task says "several sources and tools" | Nothing to normalise | Noted as missing provenance |

## 11. Limitations and next steps

- **Scale.** The linear scan is fine into the tens of thousands of records. Beyond that the store's three functions are the seam: replace the scan with SQLite FTS5 (`trigram` tokenizer, verified available in the chosen image) or a search server, and keep the adapters.
- **Estonian morphology** is approximated (3.4).
- **The glossary** covers this dataset's vocabulary. In real use it would be maintained by analysts or replaced by a locally hosted multilingual embedding model.
- **No phrase queries, no fuzzy matching** for typos.
- **Start-up load only.** New data needs a restart.
- **No authentication or audit trail** (section 8).
- **Legacy MCP clients get a subset of the 2025 transport** (6.3): no session, no standalone GET stream, no stream resumption, no batches. Tool calls do not need any of them, and the official client works in its default mode.
- **Browser rendering is not covered by automated tests**; the logic that makes it safe is.
