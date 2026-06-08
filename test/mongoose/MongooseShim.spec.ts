import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { EnforcementPlanner } from '../../lib/constraints/Planner';
import { ProviderRegistry } from '../../lib/constraints/ProviderRegistry';
import { setActivePlan } from '../../lib/constraints/ActivePlan';
import { AccessDeniedError } from '../../lib/streaming/BoundarySignals';
import { createSaplMongoosePlugin, registerMongooseShim, unregisterMongooseShim } from '../../lib/mongoose';
import type { ConstraintHandlerProvider, ScopedHandler } from '../../lib/constraints/api/index';
import type { SignalKind } from '../../lib/constraints/Signal';

const SUPPORTED = new Set<SignalKind>(['decision', 'input', 'output', 'error', 'mongo_query']);

type Hook = (this: unknown) => void;

// Apply the plugin to a fake schema that records the registered hooks, so a
// hook can be invoked directly with a fake query/aggregate `this` -- the cut
// point logic without a live mongod.
const capturePlugin = (cls: ClsService): { filter: Hook; aggregate: Hook } => {
  const hooks: Partial<Record<'filter' | 'aggregate', Hook>> = {};
  const schema = {
    pre: (ops: unknown, fn: Hook) => {
      hooks[Array.isArray(ops) ? 'filter' : 'aggregate'] = fn;
    },
  };
  createSaplMongoosePlugin(cls)(schema as never);
  return { filter: hooks.filter!, aggregate: hooks.aggregate! };
};

const providerWith = (mapper: (query: unknown) => unknown): ConstraintHandlerProvider => ({
  getHandlers: (constraint): ScopedHandler[] =>
    (constraint as { type?: unknown })?.type === 'mongo:queryRewriting'
      ? [{ signal: 'mongo_query', priority: 0, shape: 'mapper', handler: mapper }]
      : [],
});

const newCls = (): ClsService => new ClsService(new AsyncLocalStorage() as never);

const fakeQuery = (filter: unknown) => ({
  _filter: filter,
  getFilter(): unknown {
    return this._filter;
  },
  setQuery(next: unknown): void {
    this._filter = next;
  },
});

// Build a plan from `provider` and run `op` with it active in CLS scope.
const withPlan = (cls: ClsService, provider: ConstraintHandlerProvider | null, op: () => void): void =>
  cls.run(() => {
    if (provider) {
      const planner = new EnforcementPlanner({ all: () => [provider] } as unknown as ProviderRegistry);
      setActivePlan(
        cls,
        planner.plan({ decision: 'PERMIT', obligations: [{ type: 'mongo:queryRewriting' }] }, SUPPORTED),
      );
    }
    op();
  });

describe('createSaplMongoosePlugin', () => {
  beforeEach(() => registerMongooseShim());
  afterEach(() => unregisterMongooseShim());

  it('leaves the filter unchanged when no plan is in scope', () => {
    const cls = newCls();
    const { filter } = capturePlugin(cls);
    const query = fakeQuery({ a: 1 });
    cls.run(() => filter.call(query));
    expect(query._filter).toEqual({ a: 1 });
  });

  it('leaves the filter unchanged with an identity handler', () => {
    const cls = newCls();
    const { filter } = capturePlugin(cls);
    const query = fakeQuery({ a: 1 });
    withPlan(
      cls,
      providerWith((q) => q),
      () => filter.call(query),
    );
    expect(query._filter).toEqual({ a: 1 });
  });

  it('replaces the filter with the narrowed result', () => {
    const cls = newCls();
    const { filter } = capturePlugin(cls);
    const query = fakeQuery({ a: 1 });
    withPlan(
      cls,
      providerWith((q) => ({ $and: [q, { tenantId: 1 }] })),
      () => filter.call(query),
    );
    expect(query._filter).toEqual({ $and: [{ a: 1 }, { tenantId: 1 }] });
  });

  it('throws AccessDeniedError fail-closed when the handler throws', () => {
    const cls = newCls();
    const { filter } = capturePlugin(cls);
    const query = fakeQuery({ a: 1 });
    const provider = providerWith(() => {
      throw new Error('rejected');
    });
    expect(() => withPlan(cls, provider, () => filter.call(query))).toThrow(AccessDeniedError);
  });

  it('passes an aggregation pipeline through when no handler rejects it', () => {
    const cls = newCls();
    const { aggregate } = capturePlugin(cls);
    const agg = { pipeline: () => [{ $match: {} }] };
    expect(() =>
      withPlan(
        cls,
        providerWith((p) => p),
        () => aggregate.call(agg),
      ),
    ).not.toThrow();
  });

  it('throws AccessDeniedError fail-closed when a handler rejects a pipeline', () => {
    const cls = newCls();
    const { aggregate } = capturePlugin(cls);
    const agg = { pipeline: () => [{ $match: {} }] };
    const provider = providerWith(() => {
      throw new Error('pipeline cannot be narrowed');
    });
    expect(() => withPlan(cls, provider, () => aggregate.call(agg))).toThrow(AccessDeniedError);
  });
});
