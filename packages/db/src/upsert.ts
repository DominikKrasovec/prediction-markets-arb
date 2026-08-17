import type pg from 'pg';

/**
 * Bulk upsert — multi-row INSERT ... ON CONFLICT DO UPDATE.
 * Columns named `created_at` or `db_created_at` are excluded from UPDATE SET.
 * Conflict keys are also excluded from UPDATE SET.
 */
export async function bulkUpsert(
  pool: pg.Pool,
  table: string,
  conflictKeys: string[],
  columns: string[],
  valueRows: unknown[][],
  batchSize = 500,
): Promise<number> {
  if (valueRows.length === 0) return 0;

  const paramsPerRow = columns.length;
  const maxBatch = Math.min(batchSize, Math.floor(60000 / paramsPerRow));
  let totalAffected = 0;

  // Columns to exclude from UPDATE: primary keys + insert-only timestamps
  const insertOnlyKeys = new Set([...conflictKeys, 'db_created_at', 'created_at']);
  const updateCols = columns.filter((c) => !insertOnlyKeys.has(c));

  let updateClause: string;
  if (!updateCols.length) {
    updateClause = 'DO NOTHING';
  } else {
    // Only bump db_updated_at when the *data* columns actually changed.
    // This prevents the sync watermark from picking up rows that were
    // re-saved by the scraper but whose content is identical — which would
    // otherwise cause an unnecessary re-upsert cascade into `markets` and
    // `market_metadata_raw` on every scrape cycle.
    const hasTimestampCol = updateCols.includes('db_updated_at');
    const dataCols = hasTimestampCol ? updateCols.filter((c) => c !== 'db_updated_at') : updateCols;
    const setClauses = dataCols.map((c) => `"${c}" = EXCLUDED."${c}"`);

    if (hasTimestampCol) {
      if (dataCols.length > 0) {
        const lhs = dataCols.map((c) => `"${table}"."${c}"`).join(', ');
        const rhs = dataCols.map((c) => `EXCLUDED."${c}"`).join(', ');
        setClauses.push(
          `"db_updated_at" = CASE WHEN (${lhs}) IS DISTINCT FROM (${rhs}) ` +
          `THEN EXCLUDED."db_updated_at" ELSE "${table}"."db_updated_at" END`,
        );
      } else {
        setClauses.push(`"db_updated_at" = EXCLUDED."db_updated_at"`);
      }
    }

    updateClause = `DO UPDATE SET ${setClauses.join(', ')}`;
  }

  const colsSql = columns.map((c) => `"${c}"`).join(', ');
  const conflictSql = conflictKeys.map((k) => `"${k}"`).join(', ');

  for (let i = 0; i < valueRows.length; i += maxBatch) {
    const batch = valueRows.slice(i, i + maxBatch);

    // Deduplicate within batch: keep last row per conflict key combo
    const conflictIdxs = conflictKeys.map((k) => columns.indexOf(k));
    const seen = new Map<string, unknown[]>();
    for (const row of batch) {
      const key = conflictIdxs.map((ci) => String(row[ci])).join('\0');
      seen.set(key, row);
    }
    const dedupedBatch = [...seen.values()];

    const valuesSql: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    for (const row of dedupedBatch) {
      const ph: string[] = [];
      for (const val of row) {
        params.push(val);
        ph.push(`$${idx++}`);
      }
      valuesSql.push(`(${ph.join(', ')})`);
    }

    const sql = `INSERT INTO "${table}" (${colsSql})
VALUES ${valuesSql.join(', ')}
ON CONFLICT (${conflictSql}) ${updateClause}`;

    const result = await pool.query(sql, params);
    totalAffected += result.rowCount ?? 0;
  }
  return totalAffected;
}
