import { AsyncLocalStorage } from 'async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { ClsService } from 'nestjs-cls';
import mongoose, { Schema } from 'mongoose';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { EnforcementPlanner } from '../../lib/constraints/Planner';
import { ProviderRegistry } from '../../lib/constraints/ProviderRegistry';
import { setActivePlan } from '../../lib/constraints/ActivePlan';
import { AccessDeniedError } from '../../lib/streaming/BoundarySignals';
import { createSaplMongoosePlugin, registerMongooseShim, unregisterMongooseShim } from '../../lib/mongoose';
import type { ConstraintHandlerProvider, ScopedHandler } from '../../lib/constraints/api/index';
import type { SignalKind } from '../../lib/constraints/Signal';

const SUPPORTED = new Set<SignalKind>(['decision', 'input', 'output', 'error', 'mongo_query']);
const OBLIGATION = { type: 'mongo:queryRewriting' };

const providerWith = (mapper: (query: unknown) => unknown): ConstraintHandlerProvider => ({
  getHandlers: (constraint): ScopedHandler[] =>
    (constraint as { type?: unknown })?.type === 'mongo:queryRewriting'
      ? [{ signal: 'mongo_query', priority: 0, shape: 'mapper', handler: mapper }]
      : [],
});

// Proves the PEP transactional contract for the shim: a fail-closed shim
// denial during an enforced method aborts the surrounding transaction, so a
// write made earlier in the same method is rolled back. A multi-document
// transaction requires a replica set, so the container starts one and the
// driver connects directly to the single member.
describe('Mongoose shim transactional rollback (integration, requires docker)', () => {
  let container: StartedTestContainer;
  let cls: ClsService;
  let Ledger: mongoose.Model<{ note?: string | null; tenantId?: number | null }>;

  beforeAll(async () => {
    container = await new GenericContainer('mongo:7')
      .withCommand(['--replSet', 'rs0'])
      .withExposedPorts(27017)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    await container.exec([
      'mongosh',
      '--quiet',
      '--eval',
      "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})",
    ]);
    await delay(3000);

    cls = new ClsService(new AsyncLocalStorage() as never);
    registerMongooseShim();
    const schema = new Schema({ note: String, tenantId: Number });
    schema.plugin(createSaplMongoosePlugin(cls));
    Ledger = mongoose.model('Ledger', schema);

    await mongoose.connect(
      `mongodb://${container.getHost()}:${container.getMappedPort(27017)}/sapl?directConnection=true`,
    );
  }, 180_000);

  afterAll(async () => {
    unregisterMongooseShim();
    await mongoose.disconnect();
    await container.stop();
  });

  const runWith = (provider: ConstraintHandlerProvider, op: () => Promise<unknown>): Promise<unknown> =>
    cls.run(async () => {
      const planner = new EnforcementPlanner({ all: () => [provider] } as unknown as ProviderRegistry);
      setActivePlan(cls, planner.plan({ decision: 'PERMIT', obligations: [OBLIGATION] }, SUPPORTED));
      return op();
    });

  it('rolls back the write when a shim denial aborts the transaction', async () => {
    const denying = providerWith(() => {
      throw new Error('handler rejected');
    });
    const session = await mongoose.startSession();
    let denied = false;
    try {
      await session.withTransaction(async () => {
        await Ledger.create([{ note: 'pending', tenantId: 9 }], { session });
        await runWith(denying, () => Ledger.find({}).session(session));
      });
    } catch (error) {
      denied = error instanceof AccessDeniedError;
    } finally {
      await session.endSession();
    }

    expect(denied).toBe(true);
    expect(await Ledger.countDocuments({ note: 'pending' })).toBe(0);
  });

  it('commits the write when the shim narrows but permits', async () => {
    const narrowing = providerWith((q) => ({ $and: [q, { tenantId: 1 }] }));
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await Ledger.create([{ note: 'kept', tenantId: 1 }], { session });
        await runWith(narrowing, () => Ledger.find({}).session(session));
      });
    } finally {
      await session.endSession();
    }

    expect(await Ledger.countDocuments({ note: 'kept' })).toBe(1);
  });
});
