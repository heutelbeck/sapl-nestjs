import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import mongoose, { Schema } from 'mongoose';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { EnforcementPlanner } from '../../lib/constraints/Planner';
import { ProviderRegistry } from '../../lib/constraints/ProviderRegistry';
import { setActivePlan } from '../../lib/constraints/ActivePlan';
import { AccessDeniedError } from '../../lib/streaming/BoundarySignals';
import {
  createSaplMongoosePlugin,
  registerMongooseShim,
  unregisterMongooseShim,
  MongoDbQueryRewritingProvider,
} from '../../lib/mongoose';
import type { ConstraintHandlerProvider, ScopedHandler } from '../../lib/constraints/api/index';
import type { SignalKind } from '../../lib/constraints/Signal';
import type { AuthorizationDecision } from '../../lib/types';

const SUPPORTED = new Set<SignalKind>(['decision', 'input', 'output', 'error', 'mongo_query']);
const OBLIGATION = { type: 'mongo:queryRewriting' };

// A provider that claims the mongo:queryRewriting obligation and attaches
// the given mapper to the mongo_query signal. Stands in for the real
// rewriting provider so the integration exercises the cut point with an
// arbitrary, test-controlled transform.
const providerWith = (mapper: (query: unknown) => unknown): ConstraintHandlerProvider => ({
  getHandlers: (constraint): ScopedHandler[] =>
    (constraint as { type?: unknown })?.type === 'mongo:queryRewriting'
      ? [{ signal: 'mongo_query', priority: 0, shape: 'mapper', handler: mapper }]
      : [],
});

describe('Mongoose query-manipulation shim (integration, requires docker)', () => {
  let container: StartedTestContainer;
  let cls: ClsService;
  let Widget: mongoose.Model<{ name?: string | null; tenantId?: number | null }>;

  beforeAll(async () => {
    container = await new GenericContainer('mongo:7')
      .withExposedPorts(27017)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    cls = new ClsService(new AsyncLocalStorage() as never);
    registerMongooseShim();

    const schema = new Schema({ name: String, tenantId: Number });
    schema.plugin(createSaplMongoosePlugin(cls));
    Widget = mongoose.model('Widget', schema);

    await mongoose.connect(`mongodb://${container.getHost()}:${container.getMappedPort(27017)}/sapl`);
    await Widget.create([
      { name: 'a', tenantId: 1 },
      { name: 'b', tenantId: 1 },
      { name: 'c', tenantId: 2 },
    ]);
  }, 120_000);

  afterAll(async () => {
    unregisterMongooseShim();
    await mongoose.disconnect();
    await container.stop();
  });

  // Run `op` inside a CLS scope, optionally with a plan built from `provider`
  // active. Without a provider, no plan is set (the no-enforcement path).
  const run = <T>(provider: ConstraintHandlerProvider | null, op: () => Promise<T>): Promise<T> =>
    cls.run(async () => {
      if (provider) {
        const planner = new EnforcementPlanner({ all: () => [provider] } as unknown as ProviderRegistry);
        setActivePlan(cls, planner.plan({ decision: 'PERMIT', obligations: [OBLIGATION] }, SUPPORTED));
      }
      return op();
    });

  it('returns all rows when no plan is in scope', async () => {
    const rows = await run(null, () => Widget.find({}).lean());
    expect(rows).toHaveLength(3);
  });

  it('passes the filter through unchanged with an identity handler', async () => {
    const rows = await run(
      providerWith((q) => q),
      () => Widget.find({}).lean(),
    );
    expect(rows).toHaveLength(3);
  });

  it('narrows the result set when the handler adds a condition', async () => {
    const rows = await run(
      providerWith((q) => ({ $and: [q, { tenantId: 1 }] })),
      () => Widget.find({}).lean(),
    );
    expect(rows.map((r) => r.name).sort()).toEqual(['a', 'b']);
    expect(rows).toHaveLength(2);
  });

  it('denies fail-closed when the handler throws', async () => {
    const find = run(
      providerWith(() => {
        throw new Error('handler rejected');
      }),
      () => Widget.find({}).lean(),
    );
    await expect(find).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('denies an aggregation pipeline fail-closed when a handler rejects it', async () => {
    const agg = run(
      providerWith(() => {
        throw new Error('pipeline cannot be narrowed');
      }),
      () => Widget.aggregate([{ $match: {} }]),
    );
    await expect(agg).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('narrows via the real MongoDbQueryRewritingProvider from a typed obligation', async () => {
    const rows = await cls.run(async () => {
      const planner = new EnforcementPlanner({
        all: () => [new MongoDbQueryRewritingProvider()],
      } as unknown as ProviderRegistry);
      const decision: AuthorizationDecision = {
        decision: 'PERMIT',
        obligations: [
          { type: 'mongo:queryRewriting', criteria: [{ column: 'tenantId', op: '=', value: 1 }] },
        ],
      };
      setActivePlan(cls, planner.plan(decision, SUPPORTED));
      return Widget.find({}).lean();
    });
    expect(rows.map((r) => r.name).sort()).toEqual(['a', 'b']);
  });
});
