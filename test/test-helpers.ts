import { CLS_REQ } from 'nestjs-cls';
import { SubscriptionContext } from '../lib/SubscriptionContext';
import { EnforcementPlanner } from '../lib/constraints/Planner';
import { ProviderRegistry } from '../lib/constraints/ProviderRegistry';
import type { ConstraintHandlerProvider, ScopedHandler } from '../lib/constraints/api/index';

/**
 * Build an EnforcementPlanner backed by an in-memory provider registry.
 * Tests register handler factories per signal kind; the planner emits
 * the corresponding scoped handlers when it sees an obligation with
 * `{ type: 'test' }` (or any constraint, since the fake provider claims
 * every constraint it is given).
 */
export interface FakePlannerSpec {
  onDecision?: () => void; // runner at decision signal
  onInput?: (args: unknown[]) => unknown[] | void; // mapper at input signal
  onOutput?: (value: unknown) => unknown | void; // mapper at output signal
  onError?: (error: Error) => Error | void; // mapper at error signal
  onCancel?: () => void;
  onComplete?: () => void;
  onTermination?: () => void;
  onSubscribe?: () => void;
}

export function createFakePlanner(spec: FakePlannerSpec = {}): EnforcementPlanner {
  const triples: ScopedHandler[] = [];
  if (spec.onDecision)
    triples.push({ signal: 'decision', priority: 0, shape: 'runner', handler: spec.onDecision });
  if (spec.onInput)
    triples.push({
      signal: 'input',
      priority: 0,
      shape: 'mapper',
      handler: (v) => spec.onInput!(v as unknown[]),
    });
  if (spec.onOutput) triples.push({ signal: 'output', priority: 0, shape: 'mapper', handler: spec.onOutput });
  if (spec.onError)
    triples.push({
      signal: 'error',
      priority: 0,
      shape: 'mapper',
      handler: (e) => spec.onError!(e as Error),
    });
  if (spec.onCancel) triples.push({ signal: 'cancel', priority: 0, shape: 'runner', handler: spec.onCancel });
  if (spec.onComplete)
    triples.push({ signal: 'complete', priority: 0, shape: 'runner', handler: spec.onComplete });
  if (spec.onTermination)
    triples.push({ signal: 'termination', priority: 0, shape: 'runner', handler: spec.onTermination });
  if (spec.onSubscribe)
    triples.push({ signal: 'subscribe', priority: 0, shape: 'runner', handler: spec.onSubscribe });

  const provider: ConstraintHandlerProvider = {
    getHandlers: () => triples,
  };
  const registry: ProviderRegistry = {
    all: () => (triples.length > 0 ? [provider] : []),
  } as unknown as ProviderRegistry;
  return new EnforcementPlanner(registry);
}

export function createMockRequest(overrides: Record<string, any> = {}) {
  return {
    user: { sub: '123', preferred_username: 'testuser' },
    method: 'GET',
    params: {} as Record<string, any>,
    query: {} as Record<string, any>,
    body: undefined as any,
    headers: {} as Record<string, any>,
    ip: '127.0.0.1',
    hostname: 'localhost',
    ...overrides,
  };
}

export function createMockClsService(requestOverrides: Record<string, any> = {}) {
  const request = createMockRequest(requestOverrides);
  return {
    get: jest.fn((key: any) => (key === CLS_REQ ? request : undefined)),
    request,
  };
}

export function createMockTransactionAdapter(active = false) {
  return {
    isActive: active,
    withTransaction: jest.fn(async (fn: () => Promise<any>) => fn()),
  };
}

export function createCtx(overrides: Partial<SubscriptionContext> = {}): SubscriptionContext {
  return {
    request: {},
    params: {},
    query: {},
    body: undefined,
    handler: 'testHandler',
    controller: 'TestController',
    ...overrides,
  };
}
