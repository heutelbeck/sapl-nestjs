import { Logger } from '@nestjs/common';
import { EnforcementPlanner } from '../../lib/constraints/Planner';
import { ProviderRegistry } from '../../lib/constraints/ProviderRegistry';
import { AccessDeniedError } from '../../lib/streaming/BoundarySignals';
import {
  registerShimSignal,
  unregisterShimSignal,
  shimSignals,
} from '../../lib/constraints/ShimSignalRegistry';
import type { ConstraintHandlerProvider, ScopedHandler } from '../../lib/constraints/api/index';
import type { SignalKind } from '../../lib/constraints/Signal';
import type { AuthorizationDecision } from '../../lib/types';

const BASE_SIGNALS: ReadonlySet<SignalKind> = new Set<SignalKind>(['decision', 'input', 'output', 'error']);

const mongoProvider: ConstraintHandlerProvider = {
  getHandlers: (constraint): ScopedHandler[] =>
    (constraint as { type?: unknown })?.type === 'mongo:queryRewriting'
      ? [{ signal: 'mongo_query', priority: 0, shape: 'mapper', handler: (query) => query }]
      : [],
};

const plannerWith = (providers: ConstraintHandlerProvider[]): EnforcementPlanner => {
  const registry: ProviderRegistry = { all: () => providers } as unknown as ProviderRegistry;
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  return new EnforcementPlanner(registry);
};

const permitWithMongoObligation: AuthorizationDecision = {
  decision: 'PERMIT',
  obligations: [{ type: 'mongo:queryRewriting' }],
};

describe('ShimSignalRegistry', () => {
  afterEach(() => {
    unregisterShimSignal('mongo_query');
    unregisterShimSignal('sql_query');
  });

  it('registers and withdraws a signal kind', () => {
    expect(shimSignals().has('mongo_query')).toBe(false);
    registerShimSignal('mongo_query');
    expect(shimSignals().has('mongo_query')).toBe(true);
    unregisterShimSignal('mongo_query');
    expect(shimSignals().has('mongo_query')).toBe(false);
  });

  it('is idempotent on repeated register and unregister', () => {
    registerShimSignal('sql_query');
    registerShimSignal('sql_query');
    expect([...shimSignals()].filter((s) => s === 'sql_query')).toHaveLength(1);
    unregisterShimSignal('sql_query');
    unregisterShimSignal('sql_query');
    expect(shimSignals().has('sql_query')).toBe(false);
  });

  it('returns a snapshot that cannot mutate the registry', () => {
    registerShimSignal('mongo_query');
    const snapshot = shimSignals() as Set<SignalKind>;
    snapshot.delete('mongo_query');
    expect(shimSignals().has('mongo_query')).toBe(true);
  });

  it('admits a query-manipulation obligation only when its shim signal is registered', () => {
    registerShimSignal('mongo_query');
    const supported = new Set<SignalKind>([...BASE_SIGNALS, ...shimSignals()]);

    const plan = plannerWith([mongoProvider]).plan(permitWithMongoObligation, supported);

    expect(plan.entriesFor('mongo_query')).toHaveLength(1);
    // No synthetic decision-signal failure runner was scheduled.
    expect(plan.entriesFor('decision')).toHaveLength(0);
  });

  it('rejects the obligation as INADMISSIBLE when the shim signal is not registered', () => {
    const supported = new Set<SignalKind>([...BASE_SIGNALS, ...shimSignals()]);

    const plan = plannerWith([mongoProvider]).plan(permitWithMongoObligation, supported);

    expect(plan.entriesFor('mongo_query')).toHaveLength(0);
    const decisionEntries = plan.entriesFor('decision');
    expect(decisionEntries).toHaveLength(1);
    expect(() => decisionEntries[0].handler(undefined)).toThrow(AccessDeniedError);
  });
});
