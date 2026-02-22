import { of } from 'rxjs';
import { ConstraintHandlerBundle } from '../lib/constraints/ConstraintHandlerBundle';
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

export function createMockExecutionContext(
  handlerName = 'testHandler',
  className = 'TestController',
) {
  const handler = { name: handlerName };
  const request = {
    user: { sub: '123', preferred_username: 'testuser' },
    method: 'GET',
    params: {},
    query: {},
    body: undefined,
    headers: {},
    ip: '127.0.0.1',
    hostname: 'localhost',
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => handler,
    getClass: () => ({ name: className }),
  } as any;
}

export function createMockCallHandler(result: any = { data: 'test' }) {
  return {
    handle: jest.fn(() => of(result)),
  };
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
