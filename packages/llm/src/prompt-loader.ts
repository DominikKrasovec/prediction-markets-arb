import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import Mustache from 'mustache';
import type { PromptTemplate } from '@arb/types';
import { RUNTIME_SCHEMAS } from './schemas.js';

// LLM prompts are NEVER rendered as HTML — they are sent verbatim to a
// language-model API as text. Mustache's default `{{var}}` substitution
// HTML-escapes the value, so e.g. a market title containing a literal
// `"` (Kalshi sub-titles), `/` (slugs, currency pairs), or `&` (team
// names like "Tom & Jerry") gets mangled to `&quot;`, `&#x2F;`, `&amp;`
// in the prompt. Models tolerate this but it's clearly wrong.
//
// Override Mustache's global escape function with identity so every
// `{{var}}` in every prompt template produces verbatim output. This
// module is the sole Mustache importer in the codebase (grep audit) so
// the global mutation is safe.
//
// If a prompt ever DOES need to escape something for safety, use
// `{{&var}}` (Mustache's syntax for "render this with no special
// treatment" — which under identity escape is the same as `{{var}}`,
// but makes the intent explicit) or pre-escape in the renderer call.
Mustache.escape = (text) => text;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = resolve(__dirname, '..', 'prompts');

function readOptionalFile(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf-8') : undefined;
}

function readOptionalJson(path: string): unknown | undefined {
  const content = readOptionalFile(path);
  return content ? JSON.parse(content) : undefined;
}

export function loadPromptTemplate(task: string): PromptTemplate {
  const dir = resolve(PROMPTS_DIR, task);

  const systemPrompt = readFileSync(resolve(dir, 'system.md'), 'utf-8');
  const userTemplate = readFileSync(resolve(dir, 'user-template.md'), 'utf-8');
  // Prefer runtime-generated schema (derived from @arb/types const arrays) so it
  // is always in sync with the TypeScript source without a separate build step.
  // Fall back to a hand-crafted schema.json on disk for tasks not in RUNTIME_SCHEMAS.
  const schema = (RUNTIME_SCHEMAS[task] ?? readOptionalJson(resolve(dir, 'schema.json'))) as Record<string, unknown> | undefined;
  const examples = readOptionalJson(resolve(dir, 'examples.json')) as unknown[] | undefined;

  const contentHash = createHash('sha256')
    .update(systemPrompt)
    .update(userTemplate)
    .update(JSON.stringify(schema || ''))
    .digest('hex')
    .slice(0, 16);

  return { systemPrompt, userTemplate, schema, examples, contentHash };
}

export function renderPrompt(template: string, variables: Record<string, unknown>): string {
  return Mustache.render(template, variables);
}
