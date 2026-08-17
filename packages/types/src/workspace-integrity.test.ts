/**
 * Workspace integrity — runs with every `bun test` to catch two staleness
 * classes:
 *
 *  1. LINK class (bun-on-Windows copy staleness): node_modules/@arb/* must be a
 *     live link to the workspace source, not a physical copy. Delegates to the
 *     canonical checker script — one implementation, two call sites.
 *  2. DIST class: bun resolves `src/` while tsx/node resolve `dist/`. An edit
 *     under src without `tsc -p` leaves dist stale → tsx runtimes (probes,
 *     harnesses, run-monitor) silently run old code while bun tests pass on
 *     the new code. Guard: newest mtime under src must not exceed the newest
 *     mtime under dist for every workspace package that ships a dist.
 *
 * Repair: node scripts/check-workspace-links.mjs --fix   (link class)
 *         node_modules/.bin/tsc -p packages/<pkg>        (dist class)
 */
import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/types/src
const ROOT = join(HERE, '..', '..', '..');            // repo root

function newestMtime(dir: string, exts: readonly string[]): number {
  let newest = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      newest = Math.max(newest, newestMtime(p, exts));
    } else if (exts.some((x) => e.name.endsWith(x)) && !e.name.endsWith('.test.ts')) {
      newest = Math.max(newest, statSync(p).mtimeMs);
    }
  }
  return newest;
}

describe('workspace integrity (link + dist freshness)', () => {
  it('node_modules workspace entries are live links (check-workspace-links)', () => {
    // The canonical checker exits 0 when every workspace package is a live link.
    const out = execFileSync('node', [join(ROOT, 'scripts', 'check-workspace-links.mjs')], {
      encoding: 'utf8',
    });
    expect(out).toContain('OK');
  });

  it('every built workspace package has dist at least as new as src', () => {
    const pkgsDir = join(ROOT, 'packages');
    const stale: string[] = [];
    for (const name of readdirSync(pkgsDir)) {
      const src = join(pkgsDir, name, 'src');
      const dist = join(pkgsDir, name, 'dist');
      if (!existsSync(src) || !existsSync(dist)) continue; // dist-less packages: bun-only, exempt
      const srcM = newestMtime(src, ['.ts']);
      const distM = newestMtime(dist, ['.js', '.d.ts']);
      if (srcM > distM) stale.push(`${name} (src is newer — run: node_modules/.bin/tsc -p packages/${name})`);
    }
    // A stale dist means tsx/node runtimes execute OLD code while bun tests pass on NEW code.
    expect(stale).toEqual([]);
  });
});
