/**
 * E2E smoke for event_name normalization (Option B + A seeding).
 *
 * Picks a sample of cross-platform election markets, runs each title
 * through normalizeEventNoun() with year derived from extractEventDate(),
 * and checks that Polymarket + Kalshi rows for the same election
 * produce IDENTICAL canonical_event strings.
 *
 * Doesn't write to the DB — pure read + normalize verification.
 */
import { query } from '@arb/db';
import { normalizeEventNoun, yearFromIso } from '../stage1-normalize/event-name-normalizer.js';
import { extractEventDate } from '../stage1-normalize/event-date-extractor.js';

interface Row {
  market_id: number;
  platform: string;
  platform_id: string;
  title: string;
  slug: string | null;
  end_date: string | null;
  canonical_event_current: string | null;
}

async function main() {
  // Election + championship + stage_advance markets across both platforms.
  const rows = await query<Row>(
    `SELECT m.id AS market_id, m.platform, m.platform_id, m.title, m.slug,
            to_char(m.end_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS end_date,
            LEFT(n.canonical_event, 60) AS canonical_event_current
       FROM markets m
       JOIN llm_market_normalizations n ON n.market_id = m.id
      WHERE
        (m.title ~* 'presidential election' AND n.canonical_subject IN (
          'Daniel Quintero', 'Valérie Pécresse', 'Fernando Haddad',
          'Carlos Álvarez', 'Wolfgang Grozo', 'Yaël Braun-Pivet'
        ))
        OR (m.title ~* 'win the .*(Champions League|Premier League|NBA Champion|Stanley Cup|World Series|World Cup)')
        OR m.title ~* 'advance to the Conference Finals'
      ORDER BY m.title
      LIMIT 50`,
  );

  console.log(`[smoke] sampled ${rows.length} election markets`);
  console.log('');

  // Group by canonical subject and compare cross-platform normalization.
  const bySubject = new Map<string, { platform: string; old: string; nu: string; date: string | null; year: number | null }[]>();
  for (const r of rows) {
    const ed = extractEventDate({
      platform: r.platform,
      platform_id: r.platform_id,
      title: r.title,
      slug: r.slug,
      end_date: r.end_date,
      mve_selected_legs: null,
    });
    const year = yearFromIso(ed?.iso);
    const normalized = normalizeEventNoun(r.title, year) || r.title;

    const subject = r.title.split('win')[1]?.trim() ?? r.title;
    const key = subject.toLowerCase().slice(0, 40);
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key)!.push({
      platform: r.platform,
      old: r.canonical_event_current ?? '(null)',
      nu: normalized,
      date: ed?.iso ?? r.end_date,
      year,
    });
  }

  let allMatch = true;
  for (const [_key, entries] of bySubject) {
    if (entries.length < 2) continue;
    const uniqueNew = new Set(entries.map((e) => e.nu));
    const matchSymbol = uniqueNew.size === 1 ? 'PASS' : 'FAIL';
    if (uniqueNew.size !== 1) allMatch = false;

    console.log(`--- subject group (${entries.length} platforms): [${matchSymbol}]`);
    for (const e of entries) {
      console.log(`  ${e.platform.padEnd(11)} year=${e.year ?? 'NULL'} date=${e.date}`);
      console.log(`    OLD canonical_event: "${e.old}"`);
      console.log(`    NEW canonical_event: "${e.nu}"`);
    }
    console.log('');
  }

  console.log(`[smoke] overall: ${allMatch ? 'PASS' : 'FAIL'} — all cross-platform groups converged`);
  process.exit(allMatch ? 0 : 1);
}

main().catch((e) => { console.error('[smoke] ERROR:', e); process.exit(1); });
