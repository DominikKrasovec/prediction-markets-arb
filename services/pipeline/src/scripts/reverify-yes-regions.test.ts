/**
 * W3-A reverify-yes-regions — pure tests (no DB, no LLM).
 * Pins the failure-class bucketing, the token estimator, and the NEW
 * event-reverify prompt template (loads + renders + schema contract).
 */
import { describe, test, expect } from 'bun:test';
import { loadPromptTemplate, renderPrompt } from '@arb/llm';
import { estimateTokens, failureClass } from './reverify-yes-regions.js';
import { TRANSIENT_SENTINELS } from '../db/queries/semantic-events.js';

describe('failureClass bucketing', () => {
  test('transient sentinels keep their own bucket', () => {
    for (const s of TRANSIENT_SENTINELS) {
      expect(failureClass(s)).toBe(`transient: ${s}`);
    }
  });

  test('guard tail is extracted and ids/values are folded', () => {
    expect(failureClass('Both events are the same match. [leg market_id 4231844 is not a child of either event]'))
      .toBe('leg market_id # is not a child of either event');
    expect(failureClass('reasoning text ["Brooklyn Nets" shared by outcomes nets_win and nets_cover]'))
      .toBe('"…" shared by outcomes nets_win and nets_cover');
  });

  test('digit folding collapses per-pair ids into one histogram bucket', () => {
    const a = failureClass('x [confidence 0.55 below minimum 0.6]');
    const b = failureClass('y [confidence 0.41 below minimum 0.6]');
    expect(a).toBe(b);
    expect(a).toContain('#');
  });

  test('null / untagged reasoning', () => {
    expect(failureClass(null)).toBe('(no reasoning)');
    expect(failureClass('plain reasoning with no bracket tail')).toBe('(no guard tag)');
  });
});

describe('estimateTokens', () => {
  test('chars/4, ceil', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('event-reverify prompt template (new prompt asset)', () => {
  const template = loadPromptTemplate('event-reverify');

  test('loads with a YES-region system prompt and a disk schema', () => {
    expect(template.systemPrompt).toContain('YES-region');
    expect(template.systemPrompt).toContain('Ω');
    // pass-2 must check all three resolution-semantics dimensions
    expect(template.systemPrompt.toLowerCase()).toContain('oracle');
    expect(template.systemPrompt.toLowerCase()).toContain('temporal scope');
    expect(template.systemPrompt.toLowerCase()).toContain('exception rules');
    const schema = template.schema as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema).toBeDefined();
    for (const f of ['yes_region_a', 'yes_region_b', 'relation', 'same_event', 'confidence', 'reasoning']) {
      expect(schema.required).toContain(f);
    }
  });

  test('renders both sides with children and stays BLIND (no pass-1 verdict, no ann distance)', () => {
    const side = (n: number) => ({
      platform: n === 1 ? 'kalshi' : 'polymarket',
      platform_event_id: `EV-${n}`,
      title: `Event title ${n}`,
      grouping_type: 'categorical_exclusive',
      canonical_subject: 'Subject',
      participants_str: 'A, B',
      deadline: '2026-07-01',
      condition_date: '2026-06-30',
      condition_date_precision: 'day',
      total_children: 2,
      is_sampled: false,
      shown_children: 2,
      children: [
        { market_id: 100 + n, title: `child market ${n}a`, resolution_scope: 'regulation' },
        { market_id: 200 + n, title: `child market ${n}b`, resolution_scope: null },
      ],
    });
    const rendered = renderPrompt(template.userTemplate, { side_a: side(1), side_b: side(2) });
    expect(rendered).toContain('Event title 1');
    expect(rendered).toContain('Event title 2');
    expect(rendered).toContain('market_id 101');
    expect(rendered).toContain('[scope: regulation]');
    expect(rendered).not.toContain('ann_cosine_distance');
    expect(rendered).not.toContain('{{'); // every placeholder consumed
  });
});
