/**
 * Unit tests for buildBeginCommand — the `BEGIN` string that withTx issues.
 *
 * The arb-solver constraint-graph loader must read all its tables
 * inside ONE `REPEATABLE READ` snapshot so a load racing a Stage-4 finalize
 * cannot observe a half-rebuilt graph. `withTx(fn, { isolationLevel:
 * 'REPEATABLE READ', readOnly: true })` is the shared path; this pins the exact
 * command it emits. Pure: no DB.
 */
import { describe, test, expect } from 'bun:test';
import { buildBeginCommand } from './pool.js';

describe('buildBeginCommand', () => {
  test('no options → bare BEGIN (unchanged historical default for every caller)', () => {
    expect(buildBeginCommand()).toBe('BEGIN');
    expect(buildBeginCommand({})).toBe('BEGIN');
  });

  test('REPEATABLE READ + readOnly → the loader snapshot command', () => {
    const cmd = buildBeginCommand({ isolationLevel: 'REPEATABLE READ', readOnly: true });
    expect(cmd).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // The load-bearing phrase the loader depends on for a single MVCC snapshot.
    expect(cmd).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ');
  });

  test('isolation level alone (no readOnly)', () => {
    expect(buildBeginCommand({ isolationLevel: 'REPEATABLE READ' }))
      .toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect(buildBeginCommand({ isolationLevel: 'SERIALIZABLE' }))
      .toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
  });

  test('readOnly alone → BEGIN READ ONLY', () => {
    expect(buildBeginCommand({ readOnly: true })).toBe('BEGIN READ ONLY');
  });
});
