// Episode grade lifecycle (factored out of run.ts so the pure
// sampling/transition logic is unit-testable, mirroring rest-crosscheck-stamp.ts).
//
// The run-monitor tracks one ArbEpisode per arbing cluster. Two adjudication needs
// motivate this module:
//   (i)  Detect a transition INTO the `clean` execution grade so the caller can
//        ALWAYS persist a full fire record for it (bypassing the once-per-cluster +
//        material-reprice sampling), so a clean window is never lost to sampling.
//   (ii) Carry the grade lifecycle onto the episode record: the grade at open, the
//        SAFEST grade ever seen, and the grade at close — so a post-hoc reader can
//        tell whether an episode ever reached clean even if it closed at caution/risky.
import type { ExecutionGrade } from '../solver/execution-grade.js';

// Execution-grade quality rank (higher = safer). Episodes never hold `blocked` (a
// blocked portfolio is a refusal that closes the episode), but rank it for totality.
export const GRADE_RANK: Record<ExecutionGrade, number> = { clean: 3, caution: 2, risky: 1, blocked: 0 };

/** The safer of two grades (higher rank wins; ties return `a`). */
export function betterGrade(a: ExecutionGrade, b: ExecutionGrade): ExecutionGrade {
  return GRADE_RANK[a] >= GRADE_RANK[b] ? a : b;
}

/**
 * A fire is a transition INTO `clean` when it grades clean now AND the previous fire
 * did NOT (or there was no previous fire — the first fire of a cluster that opens
 * clean). Re-entry counts: a cluster that went clean → caution → clean transitions
 * again, so each clean window is independently persisted. `prevGrade === undefined`
 * ⇒ first fire.
 */
export function isCleanTransition(prevGrade: ExecutionGrade | undefined, grade: ExecutionGrade): boolean {
  return grade === 'clean' && prevGrade !== 'clean';
}

/** The three grade-lifecycle fields of an episode. */
export interface EpisodeGrades {
  /** Grade at first fire. */
  gradeAtOpen: ExecutionGrade;
  /** Safest grade seen over the episode's lifetime. */
  bestGradeSeen: ExecutionGrade;
  /** Latest fired grade (= gradeAtClose when the episode ends). */
  grade: ExecutionGrade;
}

/**
 * Fold a new fire's grade into an episode's grade lifecycle. `prev === undefined`
 * on the first fire (open): all three fields seed to `grade`. Otherwise open stays
 * pinned, best takes the safer of {best-so-far, grade}, and grade tracks the latest.
 */
export function advanceEpisodeGrades(prev: EpisodeGrades | undefined, grade: ExecutionGrade): EpisodeGrades {
  if (!prev) return { gradeAtOpen: grade, bestGradeSeen: grade, grade };
  return { gradeAtOpen: prev.gradeAtOpen, bestGradeSeen: betterGrade(prev.bestGradeSeen, grade), grade };
}
