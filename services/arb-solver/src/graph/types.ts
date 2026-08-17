import type { Platform, ConditionShape, BasisRisk } from '@arb/types';
import type { FeeModel } from '../solver/fees.js';

export interface QuestionNode {
  questionId: number;
  canonicalSubject: string;
  /** Outcome slug after the last ':' — discriminates co-slot outcomes. */
  canonicalKey?: string | null;
  conditionShape: ConditionShape | null;
  conditionValue: string | null;
  conditionDate: string | null;
  valuePrimary?: number | string | null;
  valueSecondary?: number | string | null;
  conditionDirection?: string | null;
  markets: Map<number, MarketRef>;
  subjectEntities?: string[];
}

export interface MarketRef {
  marketId: number;
  platform: Platform;
  platformId: string;
  title?: string | null;
  /** Kalshi series ticker (market_metadata_raw.raw->>'event_ticker'). */
  eventTicker?: string | null;
  endDateMs?: number | null;
  negRiskEventId?: string | null;
  feeModel?: FeeModel;
  eventKind?: string | null;
}

export interface OutcomeSetRef {
  setId: number;
  setType: 'categorical' | 'threshold_series' | 'tournament' | 'bundle';
  setName: string;
  slotQuestionIds: number[]; // ordered by slot_ordinal
  /** Only meaningful for 'categorical': true = strict one-hot Σ=1; false/absent = Σ≤1
   *  (an unlisted outcome is possible, so the enumerator also emits the all-FALSE world). */
  isExhaustive?: boolean;
}

export interface EdgeRef {
  edgeId: number;
  antecedentQuestionId: number;
  consequentQuestionId: number;
  edgeType: string;
  confidence: number;
  deterministic: boolean;
  basisRisk: BasisRisk | null;
}

export interface Cluster {
  id: number;
  questions: Map<number, QuestionNode>;
  outcomeSets: OutcomeSetRef[];
  edges: EdgeRef[];
  marketIds: Set<number>;
  validStates: WorldState[];
  dirty: boolean;
  /** Questions that take the same truth value in every enumerated valid state —
   *  only arises from contradictory constraints; non-empty means Ω is mis-built. */
  pinnedQuestions?: number[];
  /** True iff pinnedQuestions is non-empty and enumeration completed exactly; a
   *  degenerate cluster is never solved for the certified channel. */
  degenerate?: boolean;
  duplicateSuspectPairs?: Array<[number, number]>;
  /** True iff V-rep enumeration over-capped and this cluster was re-routed to a
   *  facet-only solve; caps the arb grade at 'caution'. */
  relaxed?: boolean;
  /** Outcome-set ids demoted from Σ=1 to Σ≤1 by load-time completeness repair. */
  omegaCompletenessDemotedSetIds?: number[];
}

/** Truth assignment for every question in a cluster: questionId → resolves YES? */
export type WorldState = Map<number, boolean>;

export interface ConstraintGraph {
  questions: Map<number, QuestionNode>;
  outcomeSets: OutcomeSetRef[];
  edges: EdgeRef[];
  duplicateSuspectPairs?: Array<[number, number]>;
}
