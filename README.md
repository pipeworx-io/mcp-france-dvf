# @pipeworx/france-dvf

France's official property-transfer price records — "Demandes de valeurs
foncieres" (DVF), published by the Direction generale des finances publiques
(DGFiP) — every recorded sale (and a handful of other transfer types) with
price, commune, parcel, property type, surface and coordinates. Fleet #2935.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

DGFiP publishes DVF as a rolling five-year bulk release twice a year
(April/October), not as an API, so Pipeworx keeps a copy refreshed on that
same twice-yearly cycle. The underlying file carries no personal names — it
is address- and parcel-level, not person-level.

## Tools

- `fr_property_sales(commune?, postcode?, from?, to?, type?, limit?, offset?)`
  — list recorded transactions for a commune (5-digit INSEE code or a name,
  e.g. `"75111"` or `"Lyon"` — a name matches every commune whose name starts
  with it, so `"Lyon"` returns sales across all 9 Lyon arrondissements) and/or
  postcode, with optional date-range and property-type filters. Each result
  is one disposition (a specific parcel/lot in a transaction).
- `fr_property_sale(id)` — one transaction ("mutation") by its `id_mutation`
  (from a `fr_property_sales` result), with every parcel/lot it bundles and
  the shared transaction price, date and nature.
- `fr_property_stats(commune, year)` — median and average price per m²
  for a commune and year, broken out by property type (Maison/Appartement),
  plus the total transaction count. A commune name matching more than one
  commune (e.g. `"Saint-Martin"`, or a bare multi-arrondissement city name
  like `"Lyon"`) returns the list of candidates instead of a number — pass
  one INSEE code to disambiguate.

Every response carries `data_as_of` (the release date of the loaded copy),
`source`, `licence` and `coverage_note`.

### Why price-per-m² is computed from single-lot sales only

`valeur_fonciere` is the **total price of the whole transaction**, not of one
parcel — a single sale can bundle several lots (e.g. a house plus a garage,
or several apartments in one deed). Dividing that total by one lot's surface
would silently misstate the price per m². `fr_property_stats` therefore
computes price/m² only from transactions with exactly one recorded lot, of a
residential type (Maison/Appartement) with a positive built surface.
`fr_property_sales` and `fr_property_sale` are not filtered this way — they
return every recorded disposition, and each one carries `single_lot_sale` so
a caller can apply the same filter itself.

### Commune matching

Pass the 5-digit INSEE commune code for an exact match. A name is matched
case-insensitively as a *prefix* (`"Lyon"` matches `"Lyon 1er
Arrondissement"` through `"Lyon 9e Arrondissement"`, and also
`"Lyons-la-Foret"`, a different commune that happens to share the prefix) —
it is not accent-folding, so an accented name should be typed with its
accents, or looked up by INSEE code instead.

## Auth

Keyless. The tools answer only through the Pipeworx gateway, which holds the
copy of the data; a standalone `npm install` has no data to read, and every
tool throws a clear "not bound in this runtime" error there instead of
returning an empty list.

## Data sources

- DGFiP, Demandes de valeurs foncieres (DVF) — the rolling five-year bulk
  release, refreshed twice a year (April/October). Covers metropolitan
  France and the overseas departments, **excluding Alsace (departments 67,
  68), Moselle (57) and Mayotte (976)**, which keep a separate land registry
  (Livre foncier) this release does not cover.

**Licence: Licence Ouverte / Open Licence v2.0 (Etalab)** — free reuse
including commercial use, on two conditions this pack is built to honour:

1. The data must not be used to indirectly re-identify the individuals
   behind a transaction.
2. The data must not be made indexable by external search engines.

This pack exposes records only through MCP tool calls answered by the
gateway — there is no crawlable listing page for a search engine to index —
and the underlying file carries no names, so a caller sees exactly the
address- and parcel-level detail the publisher already releases, no more.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "france-dvf": {
      "url": "https://gateway.pipeworx.io/france-dvf/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/france-dvf/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/fr_property_sales \
  -H 'Content-Type: application/json' \
  -d '{"commune":"75111","from":"2025-01-01","to":"2025-12-31"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/fr_property_sales`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-france-dvf` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/france-dvf/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "france-dvf": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-france-dvf"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about France Dvf data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
