import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { EnforcementPlanner } from '../../lib/constraints/Planner';
import { ProviderRegistry } from '../../lib/constraints/ProviderRegistry';
import { setActivePlan } from '../../lib/constraints/ActivePlan';
import { AccessDeniedError } from '../../lib/streaming/BoundarySignals';
import { createSaplPrismaExtension, registerPrismaShim, unregisterPrismaShim } from '../../lib/prisma';
import type { ConstraintHandlerProvider, ScopedHandler } from '../../lib/constraints/api/index';
import type { SignalKind } from '../../lib/constraints/Signal';

const SUPPORTED = new Set<SignalKind>(['decision', 'input', 'output', 'error', 'sql_query']);

type OperationArgs = Record<string, unknown>;
type AllOperations = (ctx: {
  operation: string;
  args: OperationArgs;
  query: (args: OperationArgs) => Promise<unknown>;
}) => Promise<unknown>;

const operationHandler = (cls: ClsService): AllOperations =>
  createSaplPrismaExtension(cls).query.$allModels.$allOperations as unknown as AllOperations;

const providerWith = (mapper: (args: unknown) => unknown): ConstraintHandlerProvider => ({
  getHandlers: (constraint): ScopedHandler[] =>
    (constraint as { type?: unknown })?.type === 'sql:queryRewriting'
      ? [{ signal: 'sql_query', priority: 0, shape: 'mapper', handler: mapper }]
      : [],
});

const newCls = (): ClsService => new ClsService(new AsyncLocalStorage() as never);
const echo = async (args: OperationArgs): Promise<unknown> => args;

const withPlan = <T>(
  cls: ClsService,
  provider: ConstraintHandlerProvider | null,
  op: () => Promise<T>,
): Promise<T> =>
  cls.run(() => {
    if (provider) {
      const planner = new EnforcementPlanner({ all: () => [provider] } as unknown as ProviderRegistry);
      setActivePlan(
        cls,
        planner.plan({ decision: 'PERMIT', obligations: [{ type: 'sql:queryRewriting' }] }, SUPPORTED),
      );
    }
    return op();
  });

describe('createSaplPrismaExtension', () => {
  beforeEach(() => registerPrismaShim());
  afterEach(() => unregisterPrismaShim());

  it('passes args through unchanged when no plan is in scope', async () => {
    const handle = operationHandler(newCls());
    const result = await handle({ operation: 'findMany', args: { where: { a: 1 } }, query: echo });
    expect(result).toEqual({ where: { a: 1 } });
  });

  it('narrows args on a filter operation via the handler', async () => {
    const cls = newCls();
    const handle = operationHandler(cls);
    const provider = providerWith((args) => ({
      ...(args as OperationArgs),
      where: { AND: [(args as OperationArgs).where, { tenantId: 1 }] },
    }));
    const result = await withPlan(cls, provider, () =>
      handle({ operation: 'findMany', args: { where: { a: 1 } }, query: echo }),
    );
    expect(result).toEqual({ where: { AND: [{ a: 1 }, { tenantId: 1 }] } });
  });

  it('denies fail-closed when the handler throws', async () => {
    const cls = newCls();
    const handle = operationHandler(cls);
    const provider = providerWith(() => {
      throw new Error('rejected');
    });
    await expect(
      withPlan(cls, provider, () => handle({ operation: 'findMany', args: {}, query: echo })),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('denies a unique-key operation fail-closed when an obligation is active', async () => {
    const cls = newCls();
    const handle = operationHandler(cls);
    const provider = providerWith((args) => args);
    await expect(
      withPlan(cls, provider, () =>
        handle({ operation: 'findUnique', args: { where: { id: 1 } }, query: echo }),
      ),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('passes a filterless operation through even when an obligation is active', async () => {
    const cls = newCls();
    const handle = operationHandler(cls);
    const provider = providerWith(() => {
      throw new Error('should not be invoked for create');
    });
    const result = await withPlan(cls, provider, () =>
      handle({ operation: 'create', args: { data: { name: 'x' } }, query: echo }),
    );
    expect(result).toEqual({ data: { name: 'x' } });
  });

  it('passes through when a plan is present but carries no sql_query handler', async () => {
    const cls = newCls();
    const handle = operationHandler(cls);
    const result = await withPlan(
      cls,
      providerWith(() => ({ type: 'other' })),
      () =>
        cls.run(() => {
          setActivePlan(
            cls,
            new EnforcementPlanner({ all: () => [] } as unknown as ProviderRegistry).plan(
              { decision: 'PERMIT' },
              SUPPORTED,
            ),
          );
          return handle({ operation: 'findMany', args: { where: { a: 1 } }, query: echo });
        }),
    );
    expect(result).toEqual({ where: { a: 1 } });
  });
});
