/**
 * A page must be zipped only with a vector array of exactly its own length;
 * ids pair positionally with their vectors.
 */
import { describe, test, expect } from 'bun:test';
import { zipPageVectors } from './embed-events.js';

describe('zipPageVectors (W1-F)', () => {
  test('pairs ids with vectors positionally', () => {
    const page = [{ id: 11 }, { id: 12 }, { id: 13 }];
    const vectors = [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]];
    const items = zipPageVectors(page, vectors);
    expect(items).toEqual([
      { id: 11, vec: '[0.1,0.2]' },
      { id: 12, vec: '[0.3,0.4]' },
      { id: 13, vec: '[0.5,0.6]' },
    ]);
  });

  test('throws on fewer vectors than events (no silent shift into the bulk write)', () => {
    const page = [{ id: 1 }, { id: 2 }];
    expect(() => zipPageVectors(page, [[0.1]])).toThrow(/1 vectors for 2 events/);
  });

  test('throws on more vectors than events', () => {
    const page = [{ id: 1 }];
    expect(() => zipPageVectors(page, [[0.1], [0.2]])).toThrow(/2 vectors for 1 events/);
  });

  test('empty page zips to an empty write', () => {
    expect(zipPageVectors([], [])).toEqual([]);
  });
});
