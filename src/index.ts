interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * france-dvf — France's official property-transfer price records ("Demandes
 * de valeurs foncieres", DVF), published by the Direction generale des
 * finances publiques (DGFiP) as a rolling five-year bulk release, refreshed
 * twice a year (April/October). Fleet #2935.
 *
 * Public surfaces (README, descriptions, `source`) name the publisher and the
 * dataset only, never the download route (CLAUDE.md step 9b, fleet #2938);
 * the route lives in scripts/france-dvf/refresh.sh. The site publishes bulk
 * files only, so that script downloads the release, builds a local SQLite
 * mirror (scripts/france-dvf/build-sqlite.mjs) and loads it into a D1
 * database the gateway hands this pack as `_d1`
 * (pack-manifest "d1Binding": "FRANCE_DVF_DB"). Design note: this file +
 * store.ts.
 *
 * Covers: every recorded sale (and a handful of other transfer types) with
 * price, commune, parcel, property type, surface and coordinates. No names
 * are in the file -- it is address- and parcel-level, not person-level.
 *
 * Reuse terms: Licence Ouverte / Open Licence v2.0 (Etalab) -- free reuse
 * including commercial use, on condition the data is not used to indirectly
 * re-identify the individuals behind a transaction, and is not made
 * indexable by external search engines. See store.ts LICENCE / COVERAGE_NOTE
 * for the full text this pack honours.
 */
import {
  COVERAGE_NOTE,
  LICENCE,
  SOURCE,
  type D1Like,
  dataAsOf,
  findSales,
  normalizeType,
  requireDb,
  resolveCommuneCodes,
  saleByMutationId,
  shapeSale,
  statsByCommuneYear,
} from './store.js';

const tools: McpToolExport['tools'] = [
  {
    name: 'fr_property_sales',
    description:
      'List recorded French property-transfer prices (DVF -- Demandes de valeurs foncieres, published by DGFiP) for a commune or postcode, optionally filtered by date range and property type. Each result is one recorded disposition (a specific parcel/lot in a transaction) with price, address-level commune, parcel id, property type, built surface, land surface, room count and coordinates. Pass commune as either a 5-digit INSEE code (e.g. "75111" for Paris 11e) or a commune name (e.g. "Lyon" matches all 9 Lyon arrondissements; "Paris 11e Arrondissement"). Use for "property sales in Paris 11e in 2025" or "recent house sales in Annecy". Covers a rolling five years; excludes Alsace, Moselle and Mayotte (see data_as_of/coverage_note in the response).',
    summary: 'List DVF property-transfer records for a commune or postcode, with date/type filters.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        commune: { type: 'string', description: '5-digit INSEE commune code (e.g. "75111") or a commune name (case-insensitive prefix match, e.g. "Lyon").' },
        postcode: { type: 'string', description: '5-digit French postal code, e.g. "75011".' },
        from: { type: 'string', description: 'Earliest sale date, YYYY-MM-DD (inclusive).' },
        to: { type: 'string', description: 'Latest sale date, YYYY-MM-DD (inclusive).' },
        type: { type: 'string', description: 'Property type: "Maison" (house), "Appartement" (apartment), "Dépendance" (outbuilding), or "Local industriel. commercial ou assimilé" (commercial/industrial).' },
        limit: { type: 'number', description: 'Max results, 1-200. Default 25.' },
        offset: { type: 'number', description: 'Pagination offset. Default 0.' },
      },
    },
  },
  {
    name: 'fr_property_sale',
    description:
      'One French property transaction ("mutation") by its DVF id_mutation, as returned by fr_property_sales. Returns every lot/parcel recorded under that transaction (a sale can bundle several parcels, e.g. a house plus a garage) with the shared transaction price, date and nature. Use after fr_property_sales to see the full set of parcels in a specific sale.',
    summary: 'One DVF transaction by id_mutation, with every lot/parcel it covers.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'The id_mutation from a fr_property_sales result, e.g. "2025-123456".' },
      },
      required: ['id'],
    },
  },
  {
    name: 'fr_property_stats',
    description:
      'Median and average price per square meter for a French commune and year, broken out by property type (Maison/Appartement), plus the total number of transactions. Computed only from single-lot sales (one parcel per transaction) with a positive built surface, because the DVF price field is the total for the whole transaction and would otherwise be double-counted or misattributed across bundled lots. Pass commune as a 5-digit INSEE code or a commune name; a name matching more than one commune (e.g. "Saint-Martin") returns the list of candidates instead of a number. Use for "median price per m2 in Lyon in 2024" or "how much do apartments go for in Nantes".',
    summary: 'Median/average DVF price per m2 for a commune and year, by property type.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        commune: { type: 'string', description: '5-digit INSEE commune code (e.g. "69381" for Lyon 1er) or a commune name (e.g. "Lyon 1er Arrondissement", "Nantes"). A bare multi-arrondissement city name like "Lyon" or "Paris" returns all its arrondissements as candidates -- pass one commune.' },
        year: { type: 'number', description: 'Calendar year, e.g. 2024.' },
      },
      required: ['commune', 'year'],
    },
  },
];

function clamp(v: unknown, lo: number, hi: number, d: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d;
}
function str(v: unknown): string | null {
  return v != null && v !== '' ? String(v).trim() : null;
}

async function salesTool(db: D1Like, args: Record<string, unknown>) {
  const communeArg = str(args.commune);
  const postcode = str(args.postcode);
  if (!communeArg && !postcode) {
    return {
      found: false,
      reason: 'missing_argument',
      message: 'Pass commune (INSEE code or name) and/or postcode.',
      data_as_of: null,
      source: SOURCE,
    };
  }
  const asOf = await dataAsOf(db);
  let codeCommunes: string[] | undefined;
  let resolvedCommunes: { code: string; name: string }[] = [];
  if (communeArg) {
    resolvedCommunes = await resolveCommuneCodes(db, communeArg);
    if (!resolvedCommunes.length) {
      return {
        found: false,
        reason: 'not_found',
        commune: communeArg,
        message: `No commune matches ${JSON.stringify(communeArg)} in the DVF data as of ${asOf ?? 'the last refresh'}.`,
        hint: 'Use the 5-digit INSEE commune code for an exact match, or check spelling/accents.',
        data_as_of: asOf,
        source: SOURCE,
      };
    }
    codeCommunes = resolvedCommunes.map((c) => c.code);
  }
  const type = normalizeType(args.type);
  const rows = await findSales(db, {
    codeCommunes,
    codePostal: postcode ?? undefined,
    from: str(args.from) ?? undefined,
    to: str(args.to) ?? undefined,
    type: type ?? undefined,
    limit: clamp(args.limit, 1, 200, 25),
    offset: Math.max(0, Math.floor(Number(args.offset) || 0)),
  });
  return {
    found: rows.length > 0,
    commune_query: communeArg,
    communes_matched: resolvedCommunes.length ? resolvedCommunes : undefined,
    postcode: postcode ?? undefined,
    returned: rows.length,
    ...(rows.length === 0 ? { reason: 'no_match', hint: 'Widen the date range or drop the type filter.' } : {}),
    sales: rows.map(shapeSale),
    data_as_of: asOf,
    coverage_note: COVERAGE_NOTE,
    source: SOURCE,
    licence: LICENCE,
  };
}

async function saleTool(db: D1Like, args: Record<string, unknown>) {
  const id = str(args.id);
  if (!id) throw new Error('id is required');
  const rows = await saleByMutationId(db, id);
  const asOf = await dataAsOf(db);
  if (!rows.length) {
    return {
      found: false,
      reason: 'not_held',
      id_mutation: id,
      message: `No DVF transaction with id_mutation ${JSON.stringify(id)} is in the data as of ${asOf ?? 'the last refresh'}.`,
      hint: 'id_mutation comes from a fr_property_sales result.',
      data_as_of: asOf,
      source: SOURCE,
    };
  }
  const first = rows[0];
  return {
    found: true,
    id_mutation: first.id_mutation,
    date_mutation: first.date_mutation,
    nature_mutation: first.nature_mutation,
    valeur_fonciere_eur: first.valeur_fonciere,
    single_lot_sale: first.single_disposition === 1,
    lot_count: rows.length,
    lots: rows.map((r) => ({
      id_parcelle: r.id_parcelle,
      type_local: r.type_local,
      surface_reelle_bati_m2: r.surface_reelle_bati,
      nombre_pieces_principales: r.nombre_pieces_principales,
      surface_terrain_m2: r.surface_terrain,
      longitude: r.longitude,
      latitude: r.latitude,
      commune: { code_insee: r.code_commune, nom: r.nom_commune, code_postal: r.code_postal, code_departement: r.code_departement },
    })),
    data_as_of: asOf,
    coverage_note: COVERAGE_NOTE,
    source: SOURCE,
    licence: LICENCE,
  };
}

async function statsTool(db: D1Like, args: Record<string, unknown>) {
  const communeArg = str(args.commune);
  const year = Math.floor(Number(args.year));
  if (!communeArg) throw new Error('commune is required');
  if (!Number.isFinite(year) || year < 2018 || year > 2100) throw new Error('year must be a valid calendar year');
  const asOf = await dataAsOf(db);
  const resolved = await resolveCommuneCodes(db, communeArg);
  if (!resolved.length) {
    return {
      found: false,
      reason: 'not_found',
      commune: communeArg,
      message: `No commune matches ${JSON.stringify(communeArg)} in the DVF data as of ${asOf ?? 'the last refresh'}.`,
      hint: 'Use the 5-digit INSEE commune code for an exact match, or check spelling/accents.',
      data_as_of: asOf,
      source: SOURCE,
    };
  }
  if (resolved.length > 1 && !/^\d{5}$/.test(communeArg)) {
    return {
      found: false,
      reason: 'ambiguous',
      commune: communeArg,
      message: `${resolved.length} communes match ${JSON.stringify(communeArg)}. Pass one INSEE code.`,
      candidates: resolved,
      data_as_of: asOf,
      source: SOURCE,
    };
  }
  const stats = await statsByCommuneYear(db, resolved.map((c) => c.code), year);
  const found = stats.total_mutations > 0;
  return {
    found,
    ...(found ? {} : { reason: 'no_match', hint: 'Try a nearby year, or a less specific commune.' }),
    commune: resolved[0],
    year,
    total_mutations: stats.total_mutations,
    total_dispositions: stats.total_dispositions,
    by_type: stats.by_type,
    price_per_m2_methodology:
      'median/avg price per m2 are computed only from single-lot sales (one parcel per transaction) of a residential ' +
      'type with a positive built surface, to avoid dividing a bundled-lot transaction price by one lot\'s surface.',
    data_as_of: asOf,
    coverage_note: COVERAGE_NOTE,
    source: SOURCE,
    licence: LICENCE,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const bound = requireDb(args._d1);
  switch (name) {
    case 'fr_property_sales':
      return salesTool(bound, args);
    case 'fr_property_sale':
      return saleTool(bound, args);
    case 'fr_property_stats':
      return statsTool(bound, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
