#!/usr/bin/env node
// check-workspace-links.mjs — guarantee node_modules/<workspace pkg> is a LINK, never a copy.
//
// WHY THIS EXISTS
// On Windows, `bun install` occasionally materializes a workspace package into
// node_modules as a *physical copy* instead of a symlink/junction (observed for
// @arb/types after a merge that touched packages/types). Both tsc and bun resolve
// `@arb/types` THROUGH node_modules/@arb/types (tsc via the "source" export
// condition, bun via the "bun" condition — see tsconfig.base.json customConditions
// and packages/types/package.json exports). When that entry is a stale copy, BOTH
// tools read stale source: tsc reports phantom "no exported member" errors and bun
// resolves the old runtime code. The two agree with each other but disagree with
// the real packages/*/src — the classic staleness class.
//
// FIX DOCTRINE
// The clean structural fix is NOT tsconfig `paths` (bun runs from the repo root,
// where there is no root tsconfig.json, so bun would ignore the paths while tsc
// honored them -> runtime/compile-time DIVERGENCE, strictly worse). Instead we keep
// the existing resolution (both tools go through node_modules) and guarantee the
// node_modules entry is always a link to the real workspace dir. Then tsc and bun
// read the identical live source by construction.
//
//   --check (default) : loud failure + exit 1 if any workspace pkg is a copy / wrong target / missing.
//   --fix             : replace confirmed physical copies with a link (symlink, junction fallback).
//                       Wired as `postinstall` so every install self-heals.
//
// SAFETY (Windows worktree-junction hazard, docs/kb/TRAPS-REGISTRY.md): we only ever
// delete an entry that `fs.readlinkSync` proves is NOT a reparse point (a genuine
// physical copy). We never delete a junction/symlink, so we can never follow a link
// into the shared main checkout and delete real files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIX = process.argv.includes('--fix');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');

/** Expand a workspaces glob entry (only the trailing "/*" form and literals are used here). */
function expandWorkspace(pattern) {
  if (pattern.endsWith('/*')) {
    const base = path.join(ROOT, pattern.slice(0, -2));
    if (!fs.existsSync(base)) return [];
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(base, d.name));
  }
  const p = path.join(ROOT, pattern);
  return fs.existsSync(p) ? [p] : [];
}

/** Build { pkgName -> absolute workspace dir } from the root package.json workspaces. */
function workspacePackages() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const globs = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : rootPkg.workspaces?.packages ?? [];
  const map = new Map();
  for (const g of globs) {
    for (const dir of expandWorkspace(g)) {
      const pj = path.join(dir, 'package.json');
      if (!fs.existsSync(pj)) continue;
      try {
        const name = JSON.parse(fs.readFileSync(pj, 'utf8')).name;
        if (name) map.set(name, dir);
      } catch {
        /* ignore unparseable package.json */
      }
    }
  }
  return map;
}

/** Classify a node_modules entry for a workspace package. */
function classify(linkPath, wsDir) {
  if (!fs.existsSync(linkPath)) return { state: 'missing' };
  let target;
  try {
    target = fs.readlinkSync(linkPath); // works for symlinks AND Windows junctions
  } catch (e) {
    if (e.code === 'EINVAL') return { state: 'copy' }; // real dir, not a reparse point
    return { state: 'error', detail: e.message };
  }
  // It's a link (symlink or junction). Verify it points at the real workspace dir.
  try {
    const real = fs.realpathSync(linkPath);
    if (path.resolve(real) === path.resolve(fs.realpathSync(wsDir))) {
      return { state: 'ok' };
    }
    return { state: 'wrong-target', detail: `${target} (resolves to ${real})` };
  } catch (e) {
    return { state: 'wrong-target', detail: `${target} (dangling: ${e.code})` };
  }
}

/** Create a link at linkPath -> wsDir. Prefer a real symlink; fall back to a junction (no admin). */
function makeLink(linkPath, wsDir) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    fs.symlinkSync(wsDir, linkPath, process.platform === 'win32' ? 'dir' : undefined);
  } catch (e) {
    if (process.platform === 'win32' && (e.code === 'EPERM' || e.code === 'EACCES')) {
      fs.symlinkSync(wsDir, linkPath, 'junction');
    } else {
      throw e;
    }
  }
}

const pkgs = workspacePackages();
const problems = [];

for (const [name, wsDir] of pkgs) {
  const linkPath = path.join(NM, ...name.split('/'));
  const { state, detail } = classify(linkPath, wsDir);
  if (state === 'ok') continue;

  if (state === 'copy' && FIX) {
    // Proven a physical copy (readlinkSync EINVAL) — safe to remove; it is NOT a reparse point.
    fs.rmSync(linkPath, { recursive: true, force: true });
    makeLink(linkPath, wsDir);
    console.log(`[link-fix] relinked ${name} -> ${path.relative(ROOT, wsDir)} (was a stale physical copy)`);
    continue;
  }
  if (state === 'missing' && FIX) {
    makeLink(linkPath, wsDir);
    console.log(`[link-fix] created ${name} -> ${path.relative(ROOT, wsDir)} (was missing)`);
    continue;
  }
  problems.push({ name, wsDir, linkPath, state, detail });
}

if (problems.length === 0) {
  console.log(`[link-check] OK — ${pkgs.size} workspace packages are all live links.`);
  process.exit(0);
}

console.error('\n[link-check] WORKSPACE LINK INTEGRITY FAILURE');
console.error('  node_modules entries below are NOT live links to their workspace source.');
console.error('  tsc and bun will read STALE code from them (bun-on-Windows copy staleness).\n');
for (const p of problems) {
  const why = {
    copy: 'PHYSICAL COPY (stale-prone — edits to source will not propagate)',
    'wrong-target': `WRONG TARGET: ${p.detail}`,
    missing: 'MISSING (no node_modules entry)',
    error: `UNREADABLE: ${p.detail}`,
  }[p.state];
  console.error(`  - ${p.name}  ->  ${why}`);
}
console.error('\n  Repair with:  node scripts/check-workspace-links.mjs --fix\n');
process.exit(1);
