/**
 * Tests for foldAscii — the diacritic-insensitive normalizer used by
 * tokenize() (Tier-2 entity-subject token comparison) and
 * extractSignificantTokens() (findOrCreateEntity fuzzy match).
 */
import { describe, test, expect } from 'bun:test';
import { foldAscii } from './entity-registry.js';

describe('foldAscii — combining diacritics (NFD path)', () => {
  test('Portuguese/Brazilian accents stripped', () => {
    expect(foldAscii('Tarcísio de Freitas')).toBe('Tarcisio de Freitas');
    expect(foldAscii('Antônio')).toBe('Antonio');
    expect(foldAscii('São Paulo')).toBe('Sao Paulo');
  });

  test('Spanish accents stripped', () => {
    expect(foldAscii('José Mourinho')).toBe('Jose Mourinho');
    expect(foldAscii('Niño')).toBe('Nino');
    expect(foldAscii('Málaga CF')).toBe('Malaga CF');
  });

  test('German umlauts stripped', () => {
    expect(foldAscii('Müller')).toBe('Muller');
    expect(foldAscii('Köln')).toBe('Koln');
    expect(foldAscii('Würzburg')).toBe('Wurzburg');
  });

  test('Czech/Slovak/Polish háčeks and acute marks stripped', () => {
    expect(foldAscii('Václav Havel')).toBe('Vaclav Havel');
    expect(foldAscii('Ondřej Palát')).toBe('Ondrej Palat');
    expect(foldAscii('Łukasz')).toBe('Lukasz');  // Ł via EXTENDED_LATIN_FOLD, not NFD
  });

  test('Scandinavian accents stripped', () => {
    expect(foldAscii('Mäki')).toBe('Maki');
    expect(foldAscii('Östersund')).toBe('Ostersund');
  });

  test('French accents stripped', () => {
    expect(foldAscii('Marseille à Paris')).toBe('Marseille a Paris');
    expect(foldAscii("L'équipe")).toBe("L'equipe");
  });
});

describe('foldAscii — extended Latin (base-letter table)', () => {
  test('Polish Ł/ł → L/l', () => {
    expect(foldAscii('Łukaszewicz')).toBe('Lukaszewicz');
    expect(foldAscii('łódź')).toBe('lodz'); // Ł→l, NFD-strip on the ó accent
  });

  test('Croatian/Serbian Đ/đ → Dj/dj', () => {
    expect(foldAscii('Đoković')).toBe('Djokovic');
    expect(foldAscii('Đorđe')).toBe('Djordje');
  });

  test('Nordic Ø/ø → O/o, Æ/æ → Ae/ae', () => {
    expect(foldAscii('Øvre Eiker')).toBe('Ovre Eiker');
    expect(foldAscii('Ærø')).toBe('Aero');
  });

  test('German ß → ss', () => {
    expect(foldAscii('Straße')).toBe('Strasse');
    expect(foldAscii('Borußia')).toBe('Borussia');
  });

  test('Icelandic Þ/þ → Th/th, Ð/ð → D/d', () => {
    expect(foldAscii('Þórður')).toBe('Thordur');
    expect(foldAscii('Sigurður')).toBe('Sigurdur');
  });
});

describe('foldAscii — passthrough (no diacritics)', () => {
  test('ASCII unchanged', () => {
    expect(foldAscii('Manchester United')).toBe('Manchester United');
    expect(foldAscii('LeBron James')).toBe('LeBron James');
    expect(foldAscii('AC Milan')).toBe('AC Milan');
  });

  test('Digits and punctuation unchanged', () => {
    expect(foldAscii('1. FC Köln')).toBe('1. FC Koln');
    expect(foldAscii("Cádiz CF vs. Real Madrid")).toBe("Cadiz CF vs. Real Madrid");
  });
});

describe('foldAscii — practical Tier-2 match scenarios', () => {
  test('"Tarcísio de Freitas" and "Tarcisio de Freitas" produce same lowercase tokens', () => {
    const tokensOf = (s: string): string[] =>
      foldAscii(s).toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
    expect(tokensOf('Tarcísio de Freitas')).toEqual(tokensOf('Tarcisio de Freitas'));
  });

  test('"Đoković" matches "Djokovic" after fold', () => {
    expect(foldAscii('Đoković').toLowerCase()).toBe('djokovic');
  });

  test('"Łukasz Fabiański" tokens match "Lukasz Fabianski"', () => {
    const tokensOf = (s: string): string[] =>
      foldAscii(s).toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
    expect(tokensOf('Łukasz Fabiański')).toEqual(tokensOf('Lukasz Fabianski'));
  });
});
