/**
 * Environment loader for @arb/db (the shared DB helper).
 *
 * Replaces a bare `import 'dotenv/config'`. It does the normal cwd-relative
 * `.env` load, then adds a WORKTREE BOOTSTRAP so DB-dependent tests stop
 * failing confusingly in fresh git worktrees that lack the (untracked) `.env`.
 *
 * Git worktrees live under `<mainRoot>/.claude/worktrees/<name>/`. A fresh
 * worktree has no `.env` (it is git-ignored, so `git worktree add` does not
 * copy it). When we are running INSIDE such a worktree and the Postgres
 * connection vars are still unset after the default load, we walk up to the
 * MAIN checkout's repo root and load ITS `.env`, emitting a single WARN line.
 *
 * Guards (fail-safe — never load the wrong env in a real deployment):
 *   - Only fires when `process.cwd()` is under a `.claude/worktrees/` path.
 *   - Never fires in CI-like contexts (`CI` env set).
 *   - Only fires when the marker var (`PG_PASSWORD`) is still unset — i.e. the
 *     default cwd-relative load found no usable `.env` and it is not in the
 *     real process environment either.
 */
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 1. Default behavior: load `.env` from the current working directory.
dotenvConfig();

// 2. Worktree fallback.
bootstrapWorktreeEnv();

function bootstrapWorktreeEnv(): void {
  // Never in CI-like contexts. (A worktree path also won't exist in CI, but be explicit.)
  if (process.env.CI) return;
  // The default load (or the real env) already supplied credentials — nothing to do.
  if (process.env.PG_PASSWORD) return;

  const cwd = process.cwd();
  // Normalize to forward slashes so the marker match is OS-independent. The
  // replace is length-preserving, so indices map back onto the original string.
  const marker = '/.claude/worktrees/';
  const idx = cwd.replace(/\\/g, '/').indexOf(marker);
  if (idx === -1) return; // not inside a worktree checkout

  const mainRoot = cwd.slice(0, idx);
  const envPath = resolve(mainRoot, '.env');
  if (!existsSync(envPath)) return;

  dotenvConfig({ path: envPath });
  // Single WARN line so the operator knows which .env is in effect.
  console.warn(
    `[@arb/db] WARN: no .env in worktree cwd (${cwd}); loaded main checkout .env from ${envPath}`,
  );
}
