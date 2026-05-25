import { Injectable, Logger } from '@nestjs/common';
import type { AuthorizationDecision } from '../types';
import { ProviderRegistry } from './ProviderRegistry';
import { EnforcementPlan, ConstraintTag, PlanEntry } from './Plan';
import { isDataCarryingSignal, type SignalKind } from './Signal';
import { AccessDeniedError } from '../streaming/BoundarySignals';
import type { ScopedHandler } from './api/index';

const ERROR_UNHANDLED_OBLIGATION = 'Unhandled obligation';
const WARN_UNHANDLED_ADVICE = 'Unhandled advice';
const SYNTHETIC_PRIORITY = 0;
const RESOURCE_SUBSTITUTION_PRIORITY = Number.MIN_SAFE_INTEGER;

type FailureReason = 'UNRESOLVED' | 'AMBIGUOUS' | 'INADMISSIBLE' | 'NON_COMMUTING';

const SHAPE_ORDER: Record<PlanEntry['shape'], number> = {
  runner: 0,
  mapper: 1,
  consumer: 2,
};

/**
 * Paper Algorithm 2 (Enforcement plan construction, paper.tex lines
 * 558-592). Two phases:
 *
 * Phase 1 -- resolve handlers per constraint (lines 567-579):
 *   For each constraint, query providers; if exactly one claims with
 *   all triples well-formed, schedule them; otherwise emit a synthetic
 *   failure runner at the decision signal.
 *
 * Phase 2 -- per-signal scheduling (lines 580-590):
 *   Sort each signal sequence by ascending priority with tiebreak
 *   Runner < Mapper < Consumer. Replace non-commuting mapper groups
 *   (multiple mappers at equal priority on the same signal) with
 *   obligation-tagged synthetic failure runners.
 *
 * Resource substitution (Spring-derived enrichment, not in the paper
 * algorithm) injects a synthetic output mapper when the decision
 * carries a top-level `resource` field and the PEP supports the
 * output signal.
 */
@Injectable()
export class EnforcementPlanner {
  private readonly logger = new Logger(EnforcementPlanner.name);

  constructor(private readonly providers: ProviderRegistry) {}

  plan(decision: AuthorizationDecision, supportedSignals: ReadonlySet<SignalKind>): EnforcementPlan {
    const entries: PlanEntry[] = [];

    for (const obligation of decision.obligations ?? []) {
      entries.push(...this.resolveConstraint(obligation, 'obligation', supportedSignals));
    }
    for (const advice of decision.advice ?? []) {
      entries.push(...this.resolveConstraint(advice, 'advice', supportedSignals));
    }
    if (decision.resource !== undefined) {
      entries.push(...this.resourceSubstitutionEntries(decision.resource, supportedSignals));
    }

    return new EnforcementPlan(this.scheduleBySignal(entries));
  }

  private resolveConstraint(
    constraint: unknown,
    tag: ConstraintTag,
    supportedSignals: ReadonlySet<SignalKind>,
  ): PlanEntry[] {
    const claims: ReadonlyArray<ScopedHandler>[] = [];
    for (const provider of this.providers.all()) {
      const triples = provider.getHandlers(constraint);
      if (triples.length > 0) claims.push(triples);
    }

    if (claims.length === 0) {
      return [this.syntheticFailureRunner(constraint, tag, 'UNRESOLVED')];
    }
    if (claims.length > 1) {
      return [this.syntheticFailureRunner(constraint, tag, 'AMBIGUOUS')];
    }

    const claim = claims[0];
    if (!claim.every((triple) => this.isWellFormed(triple, tag, supportedSignals))) {
      return [this.syntheticFailureRunner(constraint, tag, 'INADMISSIBLE')];
    }

    return claim.map((triple) => ({
      signal: triple.signal,
      priority: triple.priority,
      shape: triple.shape,
      tag,
      constraint,
      handler: triple.handler,
    }));
  }

  private isWellFormed(
    triple: ScopedHandler,
    tag: ConstraintTag,
    supportedSignals: ReadonlySet<SignalKind>,
  ): boolean {
    if (!supportedSignals.has(triple.signal)) return false;
    if (triple.shape === 'mapper' && tag === 'advice') return false;
    if (triple.shape !== 'runner' && !isDataCarryingSignal(triple.signal)) return false;
    return true;
  }

  private syntheticFailureRunner(constraint: unknown, tag: ConstraintTag, reason: FailureReason): PlanEntry {
    const logger = this.logger;
    const handler = (): void => {
      if (tag === 'obligation') {
        logger.warn(`${ERROR_UNHANDLED_OBLIGATION} (${reason})`);
        throw new AccessDeniedError(`Unhandled obligation: ${reason}`);
      }
      logger.warn(`${WARN_UNHANDLED_ADVICE} (${reason})`);
    };
    return {
      signal: 'decision',
      priority: SYNTHETIC_PRIORITY,
      shape: 'runner',
      tag,
      constraint,
      handler,
    };
  }

  private resourceSubstitutionEntries(
    replacement: unknown,
    supportedSignals: ReadonlySet<SignalKind>,
  ): PlanEntry[] {
    if (!supportedSignals.has('output')) {
      return [
        {
          signal: 'decision',
          priority: SYNTHETIC_PRIORITY,
          shape: 'runner',
          tag: 'obligation',
          constraint: { resource: replacement },
          handler: () => {
            this.logger.warn(
              'Decision carries resource substitution but PEP does not support the output signal',
            );
            throw new AccessDeniedError('Resource substitution required but output signal unsupported');
          },
        },
      ];
    }
    return [
      {
        signal: 'output',
        priority: RESOURCE_SUBSTITUTION_PRIORITY,
        shape: 'mapper',
        tag: 'obligation',
        constraint: { resource: replacement },
        handler: () => replacement,
      },
    ];
  }

  private scheduleBySignal(entries: readonly PlanEntry[]): ReadonlyMap<SignalKind, readonly PlanEntry[]> {
    const grouped = new Map<SignalKind, PlanEntry[]>();
    for (const entry of entries) {
      const bucket = grouped.get(entry.signal);
      if (bucket) bucket.push(entry);
      else grouped.set(entry.signal, [entry]);
    }
    for (const [signal, bucket] of grouped) {
      bucket.sort((a, b) => a.priority - b.priority || SHAPE_ORDER[a.shape] - SHAPE_ORDER[b.shape]);
      grouped.set(signal, this.replaceNonCommutingMappers(bucket));
    }
    return grouped;
  }

  /**
   * Paper lines 584-588: within a single signal sequence, any maximal
   * run of mappers at equal priority of size > 1 is replaced with an
   * obligation-tagged synthetic failure runner. Commutativity cannot
   * be determined in general, so the safe default is "not guaranteed".
   */
  private replaceNonCommutingMappers(bucket: readonly PlanEntry[]): PlanEntry[] {
    const scheduled: PlanEntry[] = [];
    let cursor = 0;
    while (cursor < bucket.length) {
      const entry = bucket[cursor];
      if (entry.shape !== 'mapper') {
        scheduled.push(entry);
        cursor += 1;
        continue;
      }
      let groupEnd = cursor + 1;
      while (
        groupEnd < bucket.length &&
        bucket[groupEnd].shape === 'mapper' &&
        bucket[groupEnd].priority === entry.priority
      ) {
        groupEnd += 1;
      }
      const groupSize = groupEnd - cursor;
      if (groupSize > 1) {
        // Phase 2 in-place replacement: failure fires at the same signal
        // where the offending mappers were, not at the decision signal.
        for (let index = cursor; index < groupEnd; index += 1) {
          const replaced = bucket[index];
          const synthetic = this.syntheticFailureRunner(replaced.constraint, 'obligation', 'NON_COMMUTING');
          scheduled.push({ ...synthetic, signal: replaced.signal, priority: replaced.priority });
        }
      } else {
        scheduled.push(entry);
      }
      cursor = groupEnd;
    }
    return scheduled;
  }
}
