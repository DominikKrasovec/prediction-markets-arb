import { describe, it, expect } from 'bun:test';
import {
  GRADE_RANK,
  betterGrade,
  isCleanTransition,
  advanceEpisodeGrades,
} from './episode-grade.js';
import type { ExecutionGrade } from '../solver/execution-grade.js';

// Forensics mechanism 7 — episode grade lifecycle. Pure logic; no I/O.

describe('GRADE_RANK / betterGrade', () => {
  it('ranks safest→riskiest clean > caution > risky > blocked', () => {
    expect(GRADE_RANK.clean).toBeGreaterThan(GRADE_RANK.caution);
    expect(GRADE_RANK.caution).toBeGreaterThan(GRADE_RANK.risky);
    expect(GRADE_RANK.risky).toBeGreaterThan(GRADE_RANK.blocked);
  });

  it('returns the safer grade; ties keep the first arg', () => {
    expect(betterGrade('caution', 'clean')).toBe('clean');
    expect(betterGrade('clean', 'caution')).toBe('clean');
    expect(betterGrade('risky', 'caution')).toBe('caution');
    expect(betterGrade('risky', 'risky')).toBe('risky');
  });
});

describe('isCleanTransition', () => {
  it('first fire that opens clean is a transition', () => {
    expect(isCleanTransition(undefined, 'clean')).toBe(true);
  });
  it('first fire that opens non-clean is NOT a transition', () => {
    expect(isCleanTransition(undefined, 'caution')).toBe(false);
    expect(isCleanTransition(undefined, 'risky')).toBe(false);
  });
  it('caution/risky → clean is a transition', () => {
    expect(isCleanTransition('caution', 'clean')).toBe(true);
    expect(isCleanTransition('risky', 'clean')).toBe(true);
  });
  it('clean → clean is NOT a transition (already clean, avoids re-persist flood)', () => {
    expect(isCleanTransition('clean', 'clean')).toBe(false);
  });
  it('re-entry clean → caution → clean IS a transition on re-entry', () => {
    // After leaving clean, the next clean fire re-transitions and re-persists.
    expect(isCleanTransition('caution', 'clean')).toBe(true);
  });
  it('any → non-clean is never a transition', () => {
    for (const p of ['clean', 'caution', 'risky', undefined] as (ExecutionGrade | undefined)[]) {
      expect(isCleanTransition(p, 'caution')).toBe(false);
      expect(isCleanTransition(p, 'risky')).toBe(false);
    }
  });
});

describe('advanceEpisodeGrades', () => {
  it('seeds all three fields on open (no prev)', () => {
    expect(advanceEpisodeGrades(undefined, 'caution')).toEqual({
      gradeAtOpen: 'caution',
      bestGradeSeen: 'caution',
      grade: 'caution',
    });
  });

  it('pins gradeAtOpen, tracks bestGradeSeen up, follows latest grade', () => {
    // caution (open) → risky → clean → caution
    let s = advanceEpisodeGrades(undefined, 'caution');
    s = advanceEpisodeGrades(s, 'risky');
    expect(s).toEqual({ gradeAtOpen: 'caution', bestGradeSeen: 'caution', grade: 'risky' });
    s = advanceEpisodeGrades(s, 'clean');
    expect(s).toEqual({ gradeAtOpen: 'caution', bestGradeSeen: 'clean', grade: 'clean' });
    s = advanceEpisodeGrades(s, 'caution');
    // best sticks at clean even after grade drops back
    expect(s).toEqual({ gradeAtOpen: 'caution', bestGradeSeen: 'clean', grade: 'caution' });
  });

  it('bestGradeSeen never regresses', () => {
    let s = advanceEpisodeGrades(undefined, 'clean');
    s = advanceEpisodeGrades(s, 'risky');
    expect(s.bestGradeSeen).toBe('clean');
    expect(s.grade).toBe('risky');
  });
});
