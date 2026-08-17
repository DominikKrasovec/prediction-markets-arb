/**
 * Dedicated I/O worker entry (thin bootstrap). This is the worker entry
 * io-host.ts spawns. It exists only to make the `.js`→`.ts` resolver work
 * in-worker before the real logic loads.
 *
 * `execArgv:['--import','tsx']` alone does not install the `.js`→`.ts` ESM
 * resolver hook for value imports inside a worker_thread, and static value
 * imports are hoisted and resolved before any top-level statement runs, so a
 * worker entry that statically `import`s a `.js` value module under tsx fails
 * with ERR_MODULE_NOT_FOUND before it can call `register()`.
 *
 * Keep this entry free of all `.js` value imports. Under tsx (this file is
 * `.ts`) install the hook via `register()` from 'tsx/esm/api', then
 * dynamic-import the real logic (`./io-worker-main.js`); the hook then rewrites
 * the `.js` specifiers in that module's graph to `.ts`. Under a compiled
 * `tsc --build` (this file is `.js`) `register()` is skipped and the dynamic
 * import resolves the sibling `io-worker-main.js` directly.
 *
 * `import 'dotenv/config'` first: the in-worker ClobManager (loaded by
 * io-worker-main) opens its own pg pool, so without dotenv it hits the wrong
 * Postgres port. `dotenv` + node builtins resolve without the tsx hook.
 */
import 'dotenv/config';

const isTs = import.meta.url.endsWith('.ts');
if (isTs) {
  const api = (await import('tsx/esm/api')) as { register: () => void };
  api.register();
}
// Dynamic import after register() (or compiled .js) so io-worker-main's static
// `.js` value imports (manager, io-protocol) resolve in-worker.
await import('./io-worker-main.js');
