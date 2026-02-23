import { CLS_REQ } from 'nestjs-cls';
import { ConstraintHandlerBundle } from '../lib/constraints/ConstraintHandlerBundle';
import { StreamingConstraintHandlerBundle } from '../lib/constraints/StreamingConstraintHandlerBundle';
import { SubscriptionContext } from '../lib/SubscriptionContext';

export function createMockBundle(
  overrides: Partial<ConstraintHandlerBundle> = {},
): ConstraintHandlerBundle {
  return {
    handleOnDecisionConstraints: jest.fn(),
    handleMethodInvocationHandlers: jest.fn(),
    handleAllOnNextConstraints: jest.fn((v) => v),
    handleAllOnErrorConstraints: jest.fn((e) => e),
    ...overrides,
  } as any;
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

export function createMockStreamingBundle(
  overrides: Partial<StreamingConstraintHandlerBundle> = {},
): StreamingConstraintHandlerBundle {
  return {
    handleOnDecisionConstraints: jest.fn(),
    handleAllOnNextConstraints: jest.fn((v) => v),
    handleAllOnErrorConstraints: jest.fn((e) => e),
    handleOnCompleteConstraints: jest.fn(),
    handleOnCancelConstraints: jest.fn(),
    ...overrides,
  } as any;
}

export function createCtx(
  overrides: Partial<SubscriptionContext> = {},
): SubscriptionContext {
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
