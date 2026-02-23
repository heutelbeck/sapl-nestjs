import { ClsService, CLS_REQ } from 'nestjs-cls';
import { buildContext, buildSubscriptionFromContext } from '../lib/SubscriptionBuilder';

function mockCls(request: any): ClsService {
  return { get: (key: any) => key === CLS_REQ ? request : undefined } as any;
}

describe('SubscriptionBuilder', () => {
  describe('buildContext', () => {
    test('whenClsHasRequestThenContextPopulatedFromRequest', () => {
      const request = {
        params: { id: '42' },
        query: { page: '1' },
        body: { data: 'payload' },
        user: { sub: 'alice' },
        method: 'GET',
      };

      const ctx = buildContext(mockCls(request), 'findOne', 'UserController', ['arg1']);

      expect(ctx).toEqual({
        request,
        params: { id: '42' },
        query: { page: '1' },
        body: { data: 'payload' },
        handler: 'findOne',
        controller: 'UserController',
        args: ['arg1'],
      });
    });

    test('whenClsReturnsUndefinedThenContextUsesEmptyDefaults', () => {
      const cls = { get: () => undefined } as any;

      const ctx = buildContext(cls, 'execute', 'TaskService', []);

      expect(ctx.request).toEqual({});
      expect(ctx.params).toEqual({});
      expect(ctx.query).toEqual({});
      expect(ctx.body).toBeUndefined();
      expect(ctx.handler).toBe('execute');
      expect(ctx.controller).toBe('TaskService');
    });
  });

  describe('buildSubscriptionFromContext', () => {
    const request = {
      user: { sub: 'alice', role: 'admin' },
      method: 'POST',
      ip: '127.0.0.1',
      hostname: 'localhost',
      route: { path: '/users/:id' },
      params: { id: '42' },
      query: {},
      body: { name: 'test' },
    };

    test('whenNoOverridesThenUsesDefaults', () => {
      const ctx = buildContext(mockCls(request), 'create', 'UserController', []);

      const sub = buildSubscriptionFromContext({}, ctx);

      expect(sub.subject).toEqual({ sub: 'alice', role: 'admin' });
      expect(sub.action).toEqual({
        method: 'POST',
        controller: 'UserController',
        handler: 'create',
      });
      expect(sub.resource).toEqual({
        path: '/users/:id',
        params: { id: '42' },
      });
      expect(sub.environment).toEqual({
        ip: '127.0.0.1',
        hostname: 'localhost',
      });
      expect(sub).not.toHaveProperty('secrets');
    });

    test('whenLiteralOverridesThenUsesLiterals', () => {
      const ctx = buildContext(mockCls(request), 'create', 'UserController', []);

      const sub = buildSubscriptionFromContext({
        subject: 'custom-subject',
        action: 'custom-action',
        resource: { custom: true },
        environment: 'prod',
      }, ctx);

      expect(sub.subject).toBe('custom-subject');
      expect(sub.action).toBe('custom-action');
      expect(sub.resource).toEqual({ custom: true });
      expect(sub.environment).toBe('prod');
    });

    test('whenCallbackOverridesThenCallsWithContext', () => {
      const ctx = buildContext(mockCls(request), 'create', 'UserController', []);

      const sub = buildSubscriptionFromContext({
        subject: (c: any) => c.request.user.sub,
        resource: (c: any) => ({ entityId: c.params.id }),
      }, ctx);

      expect(sub.subject).toBe('alice');
      expect(sub.resource).toEqual({ entityId: '42' });
    });

    test('whenSecretsProvidedThenIncludedInSubscription', () => {
      const ctx = buildContext(mockCls(request), 'create', 'UserController', []);

      const sub = buildSubscriptionFromContext({
        secrets: { apiKey: 'secret-123' },
      }, ctx);

      expect(sub.secrets).toEqual({ apiKey: 'secret-123' });
    });

    test('whenNoUserOnRequestThenSubjectDefaultsToAnonymous', () => {
      const noUserRequest = { ...request, user: undefined };
      const ctx = buildContext(mockCls(noUserRequest), 'list', 'PublicController', []);

      const sub = buildSubscriptionFromContext({}, ctx);

      expect(sub.subject).toBe('anonymous');
    });
  });
});
