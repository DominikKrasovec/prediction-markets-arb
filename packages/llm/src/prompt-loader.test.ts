/**
 * Tests for the prompt loader/renderer. The key contract this file pins
 * is the **no-HTML-escape policy**: every value substituted into a
 * Mustache `{{var}}` must appear in the output verbatim, never HTML-encoded.
 *
 * Background: the codebase had `{{var}}` substitutions across six prompt templates
 * (extraction, entity_enrichment, implication-cluster, entity_merge_verify,
 * regex_induction, edge-audit) where values containing `"` / `/` / `&`
 * were being silently HTML-escaped to `&quot;` / `&#x2F;` / `&amp;`. The
 * fix is a global Mustache.escape override at the renderPrompt module
 * level; this file is the regression test that pins the policy so
 * nobody accidentally reintroduces the escape.
 */
import { describe, test, expect } from 'bun:test';
import { renderPrompt } from './prompt-loader.js';

describe('renderPrompt — no HTML escape policy', () => {
  test('double-quotes in values render verbatim (not &quot;)', () => {
    const out = renderPrompt('Title: {{title}}', { title: 'Tom & Jerry: who "wins"?' });
    expect(out).toBe('Title: Tom & Jerry: who "wins"?');
    expect(out).not.toContain('&quot;');
    expect(out).not.toContain('&amp;');
  });

  test('forward slash in values renders verbatim (not &#x2F;)', () => {
    const out = renderPrompt('Slug: {{slug}}', { slug: 'ATP/WTA Tour' });
    expect(out).toBe('Slug: ATP/WTA Tour');
    expect(out).not.toContain('&#x2F;');
  });

  test('angle brackets render verbatim (not &lt; / &gt;)', () => {
    const out = renderPrompt('Value: {{v}}', { v: 'Over 200.5 <points scored>' });
    expect(out).toBe('Value: Over 200.5 <points scored>');
    expect(out).not.toContain('&lt;');
    expect(out).not.toContain('&gt;');
  });

  test('ampersand in team names renders verbatim (not &amp;)', () => {
    const out = renderPrompt('Team: {{team}}', { team: 'S&P 500' });
    expect(out).toBe('Team: S&P 500');
    expect(out).not.toContain('&amp;');
  });

  test('apostrophe / single-quote renders verbatim', () => {
    const out = renderPrompt("Name: {{name}}", { name: "O'Connor" });
    expect(out).toBe("Name: O'Connor");
    expect(out).not.toContain('&#39;');
    expect(out).not.toContain('&apos;');
  });

  test('iteration sections also render values verbatim', () => {
    const out = renderPrompt(
      'Items:\n{{#items}}- "{{.}}"\n{{/items}}',
      { items: ['Tom & Jerry', 'ATP/WTA', 'S&P 500'] },
    );
    expect(out).toContain('- "Tom & Jerry"');
    expect(out).toContain('- "ATP/WTA"');
    expect(out).toContain('- "S&P 500"');
    expect(out).not.toMatch(/&(quot|amp|#x2F|lt|gt|#39|apos);/);
  });

  test('pre-stringified JSON renders verbatim (the originally-failing case)', () => {
    // The bug originally surfaced here: the worker pre-formats aliases
    // as JSON.stringify(['DES','Bane']) → string containing literal `"`
    // chars, then Mustache HTML-escaped them. Now safe.
    const aliasesJson = JSON.stringify(['DES', 'Bane', 'D. Bane']);
    const out = renderPrompt('aliases: {{aliases_json}}', { aliases_json: aliasesJson });
    expect(out).toBe('aliases: ["DES","Bane","D. Bane"]');
    expect(out).not.toContain('&quot;');
  });
});

describe('renderPrompt — Mustache section semantics still work', () => {
  test('truthy field renders section once', () => {
    const out = renderPrompt('{{#flag}}YES{{/flag}}{{^flag}}NO{{/flag}}', { flag: true });
    expect(out).toBe('YES');
  });

  test('falsy / missing field skips section', () => {
    const out = renderPrompt('{{#flag}}YES{{/flag}}{{^flag}}NO{{/flag}}', { flag: false });
    expect(out).toBe('NO');
  });

  test('array iterates section once per element', () => {
    const out = renderPrompt('{{#items}}{{name}},{{/items}}', { items: [{ name: 'a' }, { name: 'b' }] });
    expect(out).toBe('a,b,');
  });

  test('empty array skips section entirely', () => {
    const out = renderPrompt('before {{#items}}X{{/items}}after', { items: [] });
    expect(out).toBe('before after');
  });
});
