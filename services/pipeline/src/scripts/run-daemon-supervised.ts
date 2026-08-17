/**
 * Daemon supervisor — restart-on-crash wrapper for the pipeline daemon.
 *
 * The daemon runs under bun, which can segfault on Windows under sustained
 * fetch load. Daemon state is fully persisted and startup is idempotent, so
 * the correct remedy is always "relaunch" — this wrapper does that
 * automatically so an unattended run survives.
 *
 * Run it under node (tsx), never bun — the supervisor must outlive the
 * exact runtime it is babysitting:
 *   npx tsx services/pipeline/src/scripts/run-daemon-supervised.ts
 * from the repo root (dotenv cwd). Daemon stdout/stderr pass through, so
 * redirect the supervisor's output to the usual daemon log file.
 *
 * Policy: restart on any exit (the daemon never exits on purpose) after
 * BACKOFF_MS; give up after MAX_RESTARTS within the process lifetime (a
 * genuine crash-loop must page a human, not spin). The watchdog's heartbeat
 * check stays the outer safety net: if the supervisor itself dies, the
 * heartbeat goes stale and alerts.
 *
 * The same wrapper can babysit other components. A component that
 * self-terminates by design (e.g. a bounded-duration monitor run) simply
 * rolls into the next run under this wrapper; raise DAEMON_MAX_RESTARTS
 * accordingly for a multi-day soak.
 */
import { spawn } from 'node:child_process';

const BACKOFF_MS = parseInt(process.env.DAEMON_RESTART_BACKOFF_MS ?? '10000');
const MAX_RESTARTS = parseInt(process.env.DAEMON_MAX_RESTARTS ?? '50');

// Optional argv[2]: target script to supervise (default = the daemon). Lets
// the same wrapper babysit batch pipeline runs.
const TARGET = process.argv[2] ?? 'services/pipeline/src/daemon.ts';

// Optional argv[3] (or SUPERVISOR_RUNTIME): runtime to spawn the target
// with. Default 'bun'. Other topology components must not run under bun:
// ingestion hangs at 100% CPU under bun+axios on Windows, and the solver
// monitor's runbook is tsx.
const RUNTIME = process.argv[3] ?? process.env.SUPERVISOR_RUNTIME ?? 'bun';
// 'tsx' spawns through npx: the Windows shell rejects a forward-slash
// 'node_modules/.bin/tsx' outright, and the .bin shim style differs by
// installer (bun writes tsx.exe, npm writes tsx.cmd) — npx resolves the
// checkout-local tsx either way.
const [RUNTIME_CMD, ...RUNTIME_ARGS] = RUNTIME === 'tsx' ? ['npx', 'tsx'] : [RUNTIME];

let restarts = 0;

function ts(): string {
  return new Date().toISOString();
}

function launch(): void {
  console.log(`[supervisor] ${ts()} starting ${TARGET} under ${RUNTIME} (restart #${restarts})`);
  const child = spawn(RUNTIME_CMD, [...RUNTIME_ARGS, TARGET], {
    stdio: 'inherit',
    shell: process.platform === 'win32', // resolve bun.exe / .bin shims via PATH on Windows
  });
  child.on('exit', (code, signal) => {
    console.error(`[supervisor] ${ts()} daemon exited code=${code} signal=${signal}`);
    restarts++;
    if (restarts > MAX_RESTARTS) {
      console.error(`[supervisor] ${ts()} exceeded MAX_RESTARTS=${MAX_RESTARTS} — giving up (crash-loop; investigate before restarting)`);
      process.exit(1);
    }
    console.log(`[supervisor] ${ts()} relaunching in ${BACKOFF_MS}ms`);
    setTimeout(launch, BACKOFF_MS);
  });
}

launch();
