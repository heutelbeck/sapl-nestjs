import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { PrismaPg } from '@prisma/adapter-pg';
import { EnforcementPlanner } from '../../lib/constraints/Planner';
import { ProviderRegistry } from '../../lib/constraints/ProviderRegistry';
import { setActivePlan } from '../../lib/constraints/ActivePlan';
import { AccessDeniedError } from '../../lib/streaming/BoundarySignals';
import {
  createSaplPrismaExtension,
  registerPrismaShim,
  unregisterPrismaShim,
  SqlQueryRewritingProvider,
} from '../../lib/prisma';
import type { ConstraintHandlerProvider, ScopedHandler } from '../../lib/constraints/api/index';
import type { SignalKind } from '../../lib/constraints/Signal';
import type { AuthorizationDecision } from '../../lib/types';

const ROOT = resolve(__dirname, '..', '..');
const GENERATED = resolve(__dirname, 'prisma', 'generated');
const SUPPORTED = new Set<SignalKind>(['decision', 'input', 'output', 'error', 'sql_query']);
const OBLIGATION = { type: 'sql:queryRewriting' };

const providerWith = (mapper: (args: unknown) => unknown): ConstraintHandlerProvider => ({
  getHandlers: (constraint): ScopedHandler[] =>
    (constraint as { type?: unknown })?.type === 'sql:queryRewriting'
      ? [{ signal: 'sql_query', priority: 0, shape: 'mapper', handler: mapper }]
      : [],
});

const plannerWith = (provider: ConstraintHandlerProvider): EnforcementPlanner =>
  new EnforcementPlanner({ all: () => [provider] } as unknown as ProviderRegistry);

interface Widget {
  id: number;
  name: string;
  tenantId: number;
}
interface PrismaLike {
  widget: {
    findMany: (args?: unknown) => Promise<Widget[]>;
    findUnique: (args: unknown) => Promise<Widget | null>;
    createMany: (args: unknown) => Promise<unknown>;
    create: (args: unknown) => Promise<unknown>;
    count: (args?: unknown) => Promise<number>;
  };
  $transaction: (fn: (tx: PrismaLike) => Promise<unknown>) => Promise<unknown>;
  $extends: (extension: unknown) => PrismaLike;
  $disconnect: () => Promise<void>;
}

describe('Prisma query-manipulation shim (integration, requires docker)', () => {
  let container: StartedTestContainer;
  let cls: ClsService;
  let base: PrismaLike;
  let prisma: PrismaLike;

  beforeAll(async () => {
    container = await new GenericContainer('postgres:16')
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'sapl' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    const url = `postgresql://postgres:test@${container.getHost()}:${container.getMappedPort(5432)}/sapl`;
    const env = { ...process.env, DATABASE_URL: url };
    execSync('npx prisma generate', { cwd: ROOT, env, stdio: 'ignore' });
    execSync(`npx prisma db push --url "${url}"`, { cwd: ROOT, env, stdio: 'ignore' });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient } = require(GENERATED);
    cls = new ClsService(new AsyncLocalStorage() as never);
    registerPrismaShim();
    base = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }) as PrismaLike;
    prisma = base.$extends(createSaplPrismaExtension(cls));
    await base.widget.createMany({
      data: [
        { name: 'a', tenantId: 1 },
        { name: 'b', tenantId: 1 },
        { name: 'c', tenantId: 2 },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    unregisterPrismaShim();
    await base?.$disconnect();
    await container?.stop();
  });

  const run = <T>(provider: ConstraintHandlerProvider | null, op: () => Promise<T>): Promise<T> =>
    cls.run(async () => {
      if (provider) {
        setActivePlan(
          cls,
          plannerWith(provider).plan({ decision: 'PERMIT', obligations: [OBLIGATION] }, SUPPORTED),
        );
      }
      return op();
    });

  it('returns all rows when no plan is in scope', async () => {
    const rows = await run(null, () => prisma.widget.findMany());
    expect(rows).toHaveLength(3);
  });

  it('narrows via the real SqlQueryRewritingProvider from a typed obligation', async () => {
    const rows = await cls.run(async () => {
      const decision: AuthorizationDecision = {
        decision: 'PERMIT',
        obligations: [{ type: 'sql:queryRewriting', criteria: [{ column: 'tenantId', op: '=', value: 1 }] }],
      };
      setActivePlan(cls, plannerWith(new SqlQueryRewritingProvider()).plan(decision, SUPPORTED));
      return prisma.widget.findMany();
    });
    expect(rows.map((r) => r.name).sort()).toEqual(['a', 'b']);
  });

  it('denies fail-closed when the handler throws', async () => {
    const denied = run(
      providerWith(() => {
        throw new Error('handler rejected');
      }),
      () => prisma.widget.findMany(),
    );
    await expect(denied).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('denies a unique-key operation fail-closed when an obligation is active', async () => {
    const denied = run(
      providerWith((args) => args),
      () => prisma.widget.findUnique({ where: { id: 1 } }),
    );
    await expect(denied).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('rolls back the write when a shim denial aborts the transaction', async () => {
    const attempt = cls.run(async () => {
      setActivePlan(
        cls,
        plannerWith(
          providerWith(() => {
            throw new Error('handler rejected');
          }),
        ).plan({ decision: 'PERMIT', obligations: [OBLIGATION] }, SUPPORTED),
      );
      return prisma.$transaction(async (tx) => {
        await tx.widget.create({ data: { name: 'pending', tenantId: 9 } });
        await tx.widget.findMany();
      });
    });

    await expect(attempt).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await base.widget.count({ where: { name: 'pending' } })).toBe(0);
  });
});
