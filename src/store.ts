/**
 * Reads for france-dvf (fleet #2935).
 *
 * The data is France's official "Demandes de valeurs foncieres" (DVF) --
 * every recorded property-transfer price, published by the Direction
 * generale des finances publiques (DGFiP) as a rolling five-year bulk
 * release, refreshed twice a year (April/October). This pack loads the
 * geo-coded CSV mirror into a D1 database the gateway hands it as `_d1`
 * (pack-manifest "d1Binding": "FRANCE_DVF_DB"). The table and column names
 * here must match scripts/france-dvf/build-sqlite.mjs. Refreshed by
 * .github/workflows/france-dvf-refresh.yml -- each refresh REPLACES the
 * tables (the publisher corrects historical rows in every new release
 * rather than appending to them), so from the drop until the last chunk
 * lands every tool call fails loudly via requireDb/dataAsOf, never with a
 * partial answer.
 *
 * Reuse terms: Licence Ouverte / Open Licence v2.0 (Etalab) -- free reuse
 * including commercial use, on two conditions this pack is built to honour:
 * (1) no use of the data to indirectly re-identify the individuals behind a
 * transaction, and (2) no external search-engine indexing of the data. The
 * file carries no names; every response here still carries `source`,
 * `licence` and `data_as_of`, and this pack exposes records only through
 * MCP tool calls -- there is no crawlable listing page for a search engine
 * to index.
 *
 * Coverage: metropolitan France + DOM-TOM, excluding Alsace (departments 67
 * and 68), Moselle (57) and Mayotte (976) -- those keep a separate land
 * registry (Livre foncier) the DVF release does not cover.
 */

/** The slice of Cloudflare's D1Database this pack uses, declared here so the
 *  pack needs no workers-types and a test can pass a node:sqlite stub. */
export interface D1Like {
  prepare(sql: string): D1StmtLike;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export const SOURCE = 'DGFiP, Demandes de valeurs foncieres (DVF)';
export const LICENCE =
  'Licence Ouverte / Open Licence v2.0 (Etalab) -- free reuse including commercial use, on condition the data is ' +
  'not used to indirectly re-identify the individuals behind a transaction, and is not made indexable by external ' +
  'search engines.';
export const COVERAGE_NOTE =
  'Excludes Alsace (departments 67, 68), Moselle (57) and Mayotte (976) -- those keep a separate land registry ' +
  '(Livre foncier) not covered by this release.';

export class StoreUnavailableError extends Error {
  constructor() {
    super(
      'france-dvf: the DVF store is not bound in this runtime (no _d1). These tools only answer through the Pipeworx gateway; a standalone install has no data to read.',
    );
    this.name = 'StoreUnavailableError';
  }
}
export function requireDb(d1: unknown): D1Like {
  if (!d1 || typeof (d1 as D1Like).prepare !== 'function') throw new StoreUnavailableError();
  return d1 as D1Like;
}

export async function dataAsOf(db: D1Like): Promise<string | null> {
  const r = await db.prepare(`SELECT value FROM dvf_meta WHERE key = 'data_as_of'`).first<{ value: string }>();
  return r?.value ?? null;
}

export async function meta(db: D1Like): Promise<Record<string, string>> {
  const r = await db.prepare(`SELECT key, value FROM dvf_meta`).all<{ key: string; value: string }>();
  return Object.fromEntries(r.results.map((row) => [row.key, row.value]));
}

export interface SaleRow {
  row_id: number;
  id_mutation: string;
  date_mutation: string;
  nature_mutation: string | null;
  valeur_fonciere: number | null;
  code_postal: string | null;
  code_commune: string;
  nom_commune: string | null;
  code_departement: string | null;
  id_parcelle: string | null;
  type_local: string | null;
  surface_reelle_bati: number | null;
  nombre_pieces_principales: number | null;
  surface_terrain: number | null;
  longitude: number | null;
  latitude: number | null;
  single_disposition: number;
}
const SALE_COLS = `row_id, id_mutation, date_mutation, nature_mutation, valeur_fonciere, code_postal, code_commune,
  nom_commune, code_departement, id_parcelle, type_local, surface_reelle_bati, nombre_pieces_principales,
  surface_terrain, longitude, latitude, single_disposition`;

const RESIDENTIAL_TYPES = ['Maison', 'Appartement'] as const;

/** Resolve a caller's free-form "commune" into either one exact INSEE code
 *  (5 digits, passed straight through) or a list of distinct code_commune
 *  values matching the name case-insensitively (accent-sensitive -- the
 *  stored names carry accents and SQLite has no accent-folding collation
 *  without an extension this runtime does not load). */
export async function resolveCommuneCodes(db: D1Like, commune: string): Promise<{ code: string; name: string }[]> {
  const trimmed = commune.trim();
  if (/^\d{5}$/.test(trimmed)) {
    const r = await db
      .prepare(`SELECT DISTINCT code_commune AS code, nom_commune AS name FROM dvf_sales WHERE code_commune = ? LIMIT 1`)
      .bind(trimmed)
      .all<{ code: string; name: string }>();
    return r.results;
  }
  const r = await db
    .prepare(`SELECT DISTINCT code_commune AS code, nom_commune AS name FROM dvf_sales WHERE nom_commune LIKE ? COLLATE NOCASE ORDER BY nom_commune LIMIT 30`)
    .bind(`${trimmed}%`)
    .all<{ code: string; name: string }>();
  return r.results;
}

export function normalizeType(input: unknown): string | null {
  if (input == null || input === '') return null;
  const s = String(input).trim().toLowerCase();
  if (s.startsWith('maison') || s === 'house') return 'Maison';
  if (s.startsWith('appart') || s === 'apartment' || s === 'flat') return 'Appartement';
  if (s.startsWith('dépend') || s.startsWith('depend')) return 'Dépendance';
  if (s.startsWith('local') || s.startsWith('commerc') || s.includes('industriel')) return 'Local industriel. commercial ou assimilé';
  return input as string; // pass through verbatim; the WHERE clause then just matches nothing if it's wrong
}

export interface SalesFilter {
  codeCommunes?: string[];
  codePostal?: string;
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
  type?: string;
  limit: number;
  offset: number;
}

export async function findSales(db: D1Like, f: SalesFilter): Promise<SaleRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.codeCommunes?.length) {
    where.push(`code_commune IN (${f.codeCommunes.map(() => '?').join(',')})`);
    params.push(...f.codeCommunes);
  }
  if (f.codePostal) {
    where.push(`code_postal = ?`);
    params.push(f.codePostal);
  }
  if (f.from) {
    where.push(`date_mutation >= ?`);
    params.push(f.from);
  }
  if (f.to) {
    where.push(`date_mutation <= ?`);
    params.push(f.to);
  }
  if (f.type) {
    where.push(`type_local = ?`);
    params.push(f.type);
  }
  if (!where.length) throw new Error('findSales: at least one filter is required');
  const sql = `SELECT ${SALE_COLS} FROM dvf_sales WHERE ${where.join(' AND ')} ORDER BY date_mutation DESC, row_id DESC LIMIT ? OFFSET ?`;
  params.push(f.limit, f.offset);
  const r = await db.prepare(sql).bind(...params).all<SaleRow>();
  return r.results;
}

export async function saleByMutationId(db: D1Like, idMutation: string): Promise<SaleRow[]> {
  const r = await db
    .prepare(`SELECT ${SALE_COLS} FROM dvf_sales WHERE id_mutation = ? ORDER BY row_id`)
    .bind(idMutation)
    .all<SaleRow>();
  return r.results;
}

export interface TypeStat {
  type_local: string;
  n: number;
  median_price_per_m2: number;
  avg_price_per_m2: number;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export interface StatsResult {
  commune_count: number;
  total_mutations: number;
  total_dispositions: number;
  by_type: TypeStat[];
}

/** Price/m2 is computed only from single-disposition sales of a residential
 *  type (Maison/Appartement) with a positive built surface, because
 *  valeur_fonciere is the TOTAL price of the mutation (which can bundle
 *  several lots/parcels) -- dividing a multi-lot sale's total price by one
 *  lot's surface would silently inflate or deflate the price/m2. */
export async function statsByCommuneYear(db: D1Like, codeCommunes: string[], year: number): Promise<StatsResult> {
  const yStart = `${year}-01-01`;
  const yEnd = `${year + 1}-01-01`;
  const placeholders = codeCommunes.map(() => '?').join(',');

  const totals = await db
    .prepare(
      `SELECT COUNT(DISTINCT id_mutation) AS mutations, COUNT(*) AS dispositions
       FROM dvf_sales WHERE code_commune IN (${placeholders}) AND date_mutation >= ? AND date_mutation < ?`,
    )
    .bind(...codeCommunes, yStart, yEnd)
    .first<{ mutations: number; dispositions: number }>();

  const rows = await db
    .prepare(
      `SELECT type_local, valeur_fonciere, surface_reelle_bati
       FROM dvf_sales
       WHERE code_commune IN (${placeholders}) AND date_mutation >= ? AND date_mutation < ?
         AND single_disposition = 1 AND surface_reelle_bati > 0 AND valeur_fonciere > 0
         AND type_local IN (${RESIDENTIAL_TYPES.map(() => '?').join(',')})`,
    )
    .bind(...codeCommunes, yStart, yEnd, ...RESIDENTIAL_TYPES)
    .all<{ type_local: string; valeur_fonciere: number; surface_reelle_bati: number }>();

  const byType = new Map<string, number[]>();
  for (const row of rows.results) {
    const ppm2 = row.valeur_fonciere / row.surface_reelle_bati;
    if (!Number.isFinite(ppm2) || ppm2 <= 0) continue;
    const arr = byType.get(row.type_local) ?? [];
    arr.push(ppm2);
    byType.set(row.type_local, arr);
  }
  const by_type: TypeStat[] = [...byType.entries()]
    .map(([type_local, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        type_local,
        n: sorted.length,
        median_price_per_m2: Math.round(median(sorted)),
        avg_price_per_m2: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
      };
    })
    .sort((a, b) => b.n - a.n);

  return {
    commune_count: codeCommunes.length,
    total_mutations: totals?.mutations ?? 0,
    total_dispositions: totals?.dispositions ?? 0,
    by_type,
  };
}

export function shapeSale(r: SaleRow) {
  return {
    id_mutation: r.id_mutation,
    date_mutation: r.date_mutation,
    nature_mutation: r.nature_mutation,
    valeur_fonciere_eur: r.valeur_fonciere,
    commune: { code_insee: r.code_commune, nom: r.nom_commune, code_postal: r.code_postal, code_departement: r.code_departement },
    id_parcelle: r.id_parcelle,
    type_local: r.type_local,
    surface_reelle_bati_m2: r.surface_reelle_bati,
    nombre_pieces_principales: r.nombre_pieces_principales,
    surface_terrain_m2: r.surface_terrain,
    longitude: r.longitude,
    latitude: r.latitude,
    single_lot_sale: r.single_disposition === 1,
  };
}
