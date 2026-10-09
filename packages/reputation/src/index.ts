import type { ScoringEngine } from '@prix/contracts';
import { METHOD, scoringV1 } from './v1.ts';

/** Scoring v1. docs/CONTRACTS.md section 9 specifies every function; METHOD.md explains it. */
export const scoring: ScoringEngine = scoringV1;

/** The name of the method `scoring` implements. Equal to `SCORING_METHOD` by construction. */
export const scoringMethod: typeof METHOD = METHOD;
