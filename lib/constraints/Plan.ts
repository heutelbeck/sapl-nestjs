import { Logger } from '@nestjs/common';
import type { Signal, SignalKind } from './Signal';
import type { HandlerShape } from './api/index';

const WARN_HANDLER_FAILED = 'Constraint handler failed at signal';

export type Maybe<T> = { readonly kind: 'present'; readonly value: T } | { readonly kind: 'absent' };

export const present = <T>(value: T): Maybe<T> => ({ kind: 'present', value });
export const absent: Maybe<never> = { kind: 'absent' };

export type ConstraintTag = 'obligation' | 'advice';

export interface PlanEntry {
  readonly signal: SignalKind;
  readonly priority: number;
  readonly shape: HandlerShape;
  readonly tag: ConstraintTag;
  readonly constraint: unknown;
  readonly handler: (value: unknown) => unknown | void;
}

export interface PlanResult {
  readonly value: Maybe<unknown>;
  readonly failureState: boolean;
}

/**
 * Paper Algorithm 3 (Constraint enforcement execution for any signal,
 * paper.tex lines 619-644). Best-effort discharge: the loop does NOT
 * exit on failure. Obligation failures set failureState; advice
 * failures are logged only.
 *
 * The caller (aspect) inspects the returned failureState and decides
 * routing (throw AccessDeniedError, route to FSM denial event, etc.).
 * Plan.execute does not throw on its own.
 */
export class EnforcementPlan {
  private readonly logger = new Logger(EnforcementPlan.name);

  constructor(private readonly entries: ReadonlyMap<SignalKind, readonly PlanEntry[]>) {}

  execute(signal: Signal, priorFailure = false): PlanResult {
    let value: Maybe<unknown> = 'value' in signal ? present(signal.value) : absent;
    let failureState = priorFailure;

    for (const entry of this.entries.get(signal.kind) ?? []) {
      try {
        if (entry.shape === 'runner') {
          (entry.handler as () => void)();
        } else if (value.kind === 'present') {
          if (entry.shape === 'mapper') {
            const result = entry.handler(value.value);
            if (result !== undefined) value = present(result);
          } else {
            entry.handler(value.value);
          }
        }
      } catch (error) {
        this.logger.warn(`${WARN_HANDLER_FAILED} ${entry.signal} (${entry.tag}): ${String(error)}`);
        if (entry.tag === 'obligation') {
          failureState = true;
        }
      }
    }

    return { value, failureState };
  }

  entriesFor(signal: SignalKind): readonly PlanEntry[] {
    return this.entries.get(signal) ?? [];
  }
}
