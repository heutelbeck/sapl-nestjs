import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DiscoveryModule } from '@nestjs/core';
import { Injectable } from '@nestjs/common';
import { ConstraintEnforcementService } from '../../lib/constraints/ConstraintEnforcementService';
import { SaplConstraintHandler } from '../../lib/constraints/SaplConstraintHandler';
import {
  Signal,
  RunnableConstraintHandlerProvider,
  MappingConstraintHandlerProvider,
  ConsumerConstraintHandlerProvider,
  ErrorHandlerProvider,
  ErrorMappingConstraintHandlerProvider,
  FilterPredicateConstraintHandlerProvider,
  MethodInvocationConstraintHandlerProvider,
} from '../../lib/constraints/api/index';
import { ContentFilteringProvider } from '../../lib/constraints/providers/ContentFilteringProvider';
import { ContentFilterPredicateProvider } from '../../lib/constraints/providers/ContentFilterPredicateProvider';

// -- Test providers --------------------------------------------------------

@Injectable()
@SaplConstraintHandler('runnable')
class LogOnDecisionProvider implements RunnableConstraintHandlerProvider {
  calls: any[] = [];
  isResponsible(constraint: any) { return constraint?.type === 'logAccess'; }
  getSignal() { return Signal.ON_DECISION; }
  getHandler(constraint: any) { return () => { this.calls.push(constraint); }; }
}

@Injectable()
@SaplConstraintHandler('mapping')
class LowPriorityMappingProvider implements MappingConstraintHandlerProvider {
  isResponsible(constraint: any) { return constraint?.type === 'addAuditField'; }
  getPriority() { return 1; }
  getHandler(constraint: any) { return (v: any) => ({ ...v, auditedBy: constraint.user }); }
}

@Injectable()
@SaplConstraintHandler('mapping')
class HighPriorityMappingProvider implements MappingConstraintHandlerProvider {
  isResponsible(constraint: any) { return constraint?.type === 'addAuditField'; }
  getPriority() { return 10; }
  getHandler(_constraint: any) { return (v: any) => ({ ...v, audited: true }); }
}

@Injectable()
@SaplConstraintHandler('consumer')
class AuditConsumerProvider implements ConsumerConstraintHandlerProvider {
  captured: any[] = [];
  isResponsible(constraint: any) { return constraint?.type === 'auditLog'; }
  getHandler(_constraint: any) { return (v: any) => { this.captured.push(v); }; }
}

@Injectable()
@SaplConstraintHandler('errorHandler')
class ErrorAuditProvider implements ErrorHandlerProvider {
  captured: Error[] = [];
  isResponsible(constraint: any) { return constraint?.type === 'auditError'; }
  getHandler(_constraint: any) { return (e: Error) => { this.captured.push(e); }; }
}

@Injectable()
@SaplConstraintHandler('errorMapping')
class ErrorEnrichmentProvider implements ErrorMappingConstraintHandlerProvider {
  isResponsible(constraint: any) { return constraint?.type === 'enrichError'; }
  getPriority() { return 0; }
  getHandler(_constraint: any) { return (e: Error) => new Error(`enriched: ${e.message}`); }
}

@Injectable()
@SaplConstraintHandler('filterPredicate')
class StatusFilterProvider implements FilterPredicateConstraintHandlerProvider {
  isResponsible(constraint: any) { return constraint?.type === 'filterByStatus'; }
  getHandler(constraint: any) { return (el: any) => el.status === constraint.requiredStatus; }
}

@Injectable()
@SaplConstraintHandler('methodInvocation')
class InjectHeaderProvider implements MethodInvocationConstraintHandlerProvider {
  isResponsible(constraint: any) { return constraint?.type === 'injectHeader'; }
  getHandler(constraint: any) {
    return (request: any) => { request.headers[constraint.headerName] = constraint.value; };
  }
}

@Injectable()
@SaplConstraintHandler('runnable')
class FailingRunnableProvider implements RunnableConstraintHandlerProvider {
  isResponsible(constraint: any) { return constraint?.type === 'failingRunnable'; }
  getSignal() { return Signal.ON_DECISION; }
  getHandler(_constraint: any) { return () => { throw new Error('handler failed'); }; }
}

@Injectable()
@SaplConstraintHandler('mapping')
class FailingMappingProvider implements MappingConstraintHandlerProvider {
  isResponsible(constraint: any) { return constraint?.type === 'failingMapping'; }
  getPriority() { return 0; }
  getHandler(_constraint: any) { return (_v: any) => { throw new Error('mapping failed'); }; }
}

// -- Helpers ---------------------------------------------------------------

async function createService(providers: any[] = []) {
  const module = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [ConstraintEnforcementService, ...providers],
  }).compile();

  await module.init();
  return {
    service: module.get(ConstraintEnforcementService),
    module,
    getProvider: <T>(type: new (...args: any[]) => T) => module.get(type),
  };
}

// -- Tests -----------------------------------------------------------------

describe('ConstraintEnforcementService', () => {
  describe('empty decisions', () => {
    test('whenNoObligationsOrAdviceThenReturnsBundleWithNoOpHandlers', async () => {
      const { service } = await createService();
      const bundle = service.preEnforceBundleFor({ decision: 'PERMIT' });

      expect(bundle.handleAllOnNextConstraints('value')).toBe('value');
      expect(() => bundle.handleOnDecisionConstraints()).not.toThrow();
    });
  });

  describe('unhandled obligations', () => {
    test('whenSingleUnhandledObligationThenThrowsForbiddenException', async () => {
      const { service } = await createService();

      expect(() => service.preEnforceBundleFor({
        decision: 'PERMIT',
        obligations: [{ type: 'unknownObligation' }],
      })).toThrow(ForbiddenException);
    });

    test('whenMultipleObligationsAndOneUnhandledThenThrowsForbiddenException', async () => {
      const { service } = await createService([LogOnDecisionProvider]);

      expect(() => service.preEnforceBundleFor({
        decision: 'PERMIT',
        obligations: [
          { type: 'logAccess' },
          { type: 'unknownObligation' },
          { type: 'logAccess' },
        ],
      })).toThrow(ForbiddenException);
    });

    test('whenUnhandledAdviceThenNoBundleError', async () => {
      const { service } = await createService();

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        advice: [{ type: 'unknownAdvice' }],
      });

      expect(bundle).toBeDefined();
    });
  });

  describe('obligation vs advice semantics', () => {
    test('whenObligationHandlerFailsThenBundleThrowsForbiddenException', async () => {
      const { service } = await createService([FailingRunnableProvider]);

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        obligations: [{ type: 'failingRunnable' }],
      });

      expect(() => bundle.handleOnDecisionConstraints()).toThrow(ForbiddenException);
    });

    test('whenAdviceHandlerFailsThenBundleSwallowsError', async () => {
      const { service } = await createService([FailingRunnableProvider]);

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        advice: [{ type: 'failingRunnable' }],
      });

      expect(() => bundle.handleOnDecisionConstraints()).not.toThrow();
    });

    test('whenMappingAdviceFailsThenFallbackIdentityUsed', async () => {
      const { service } = await createService([FailingMappingProvider]);

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        advice: [{ type: 'failingMapping' }],
      });

      const result = bundle.handleAllOnNextConstraints({ data: 'original' });
      expect(result).toEqual({ data: 'original' });
    });
  });

  describe('handler types as obligations', () => {
    test.each([
      {
        label: 'runnable executes on decision',
        providers: [LogOnDecisionProvider],
        constraint: { type: 'logAccess', source: 'test' },
        verify: (bundle: any, { getProvider }: any) => {
          bundle.handleOnDecisionConstraints();
          const provider = getProvider(LogOnDecisionProvider);
          expect(provider.calls).toEqual([{ type: 'logAccess', source: 'test' }]);
        },
      },
      {
        label: 'consumer inspects on next',
        providers: [AuditConsumerProvider],
        constraint: { type: 'auditLog' },
        verify: (bundle: any, { getProvider }: any) => {
          bundle.handleAllOnNextConstraints({ data: 'test' });
          const provider = getProvider(AuditConsumerProvider);
          expect(provider.captured).toEqual([{ data: 'test' }]);
        },
      },
      {
        label: 'mapping transforms on next',
        providers: [LowPriorityMappingProvider],
        constraint: { type: 'addAuditField', user: 'admin' },
        verify: (bundle: any) => {
          const result = bundle.handleAllOnNextConstraints({ data: 'x' });
          expect(result).toEqual({ data: 'x', auditedBy: 'admin' });
        },
      },
      {
        label: 'filter predicate filters array elements',
        providers: [StatusFilterProvider],
        constraint: { type: 'filterByStatus', requiredStatus: 'active' },
        verify: (bundle: any) => {
          const result = bundle.handleAllOnNextConstraints([
            { id: 1, status: 'active' },
            { id: 2, status: 'inactive' },
          ]);
          expect(result).toEqual([{ id: 1, status: 'active' }]);
        },
      },
      {
        label: 'error handler inspects errors',
        providers: [ErrorAuditProvider],
        constraint: { type: 'auditError' },
        verify: (bundle: any, { getProvider }: any) => {
          const error = new Error('test');
          bundle.handleAllOnErrorConstraints(error);
          expect(getProvider(ErrorAuditProvider).captured).toEqual([error]);
        },
      },
      {
        label: 'error mapping transforms errors',
        providers: [ErrorEnrichmentProvider],
        constraint: { type: 'enrichError' },
        verify: (bundle: any) => {
          const result = bundle.handleAllOnErrorConstraints(new Error('original'));
          expect(result.message).toBe('enriched: original');
        },
      },
      {
        label: 'method invocation mutates request',
        providers: [InjectHeaderProvider],
        constraint: { type: 'injectHeader', headerName: 'x-audit', value: 'injected' },
        verify: (bundle: any) => {
          const request = { headers: {}, params: {}, body: {} };
          bundle.handleMethodInvocationHandlers(request);
          expect(request.headers['x-audit']).toBe('injected');
        },
      },
    ])('when$label', async ({ providers, constraint, verify }) => {
      const context = await createService(providers);
      const bundle = context.service.preEnforceBundleFor({
        decision: 'PERMIT',
        obligations: [constraint],
      });
      verify(bundle, context);
    });
  });

  describe('priority ordering', () => {
    test('whenMultipleMappingProvidersThenHigherPriorityRunsFirst', async () => {
      const { service } = await createService([LowPriorityMappingProvider, HighPriorityMappingProvider]);

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        obligations: [{ type: 'addAuditField', user: 'admin' }],
      });

      const result = bundle.handleAllOnNextConstraints({});
      expect(result).toEqual({ audited: true, auditedBy: 'admin' });
    });
  });

  describe('constraint handled by multiple provider types', () => {
    test('whenConstraintMatchesBothRunnableAndMappingThenBothExecute', async () => {
      @Injectable()
      @SaplConstraintHandler('runnable')
      class DualRunnable implements RunnableConstraintHandlerProvider {
        called = false;
        isResponsible(c: any) { return c?.type === 'dualConstraint'; }
        getSignal() { return Signal.ON_DECISION; }
        getHandler() { return () => { this.called = true; }; }
      }

      @Injectable()
      @SaplConstraintHandler('mapping')
      class DualMapping implements MappingConstraintHandlerProvider {
        isResponsible(c: any) { return c?.type === 'dualConstraint'; }
        getPriority() { return 0; }
        getHandler() { return (v: any) => ({ ...v, dualMapped: true }); }
      }

      const { service, getProvider } = await createService([DualRunnable, DualMapping]);

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        obligations: [{ type: 'dualConstraint' }],
      });

      bundle.handleOnDecisionConstraints();
      const result = bundle.handleAllOnNextConstraints({ data: 'x' });

      expect(getProvider(DualRunnable).called).toBe(true);
      expect(result).toEqual({ data: 'x', dualMapped: true });
    });
  });

  describe('mixed obligations and advice', () => {
    test('whenBothObligationsAndAdviceThenBothContributeToPipeline', async () => {
      const { service, getProvider } = await createService([
        LogOnDecisionProvider,
        AuditConsumerProvider,
      ]);

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        obligations: [{ type: 'logAccess' }],
        advice: [{ type: 'auditLog' }],
      });

      bundle.handleOnDecisionConstraints();
      bundle.handleAllOnNextConstraints({ data: 'test' });

      expect(getProvider(LogOnDecisionProvider).calls).toHaveLength(1);
      expect(getProvider(AuditConsumerProvider).captured).toEqual([{ data: 'test' }]);
    });

    test('whenAdviceFailsButObligationSucceedsThenAccessStillPermitted', async () => {
      const { service, getProvider } = await createService([
        LogOnDecisionProvider,
        FailingRunnableProvider,
      ]);

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        obligations: [{ type: 'logAccess' }],
        advice: [{ type: 'failingRunnable' }],
      });

      expect(() => bundle.handleOnDecisionConstraints()).not.toThrow();
      expect(getProvider(LogOnDecisionProvider).calls).toHaveLength(1);
    });
  });

  describe('cascading failure', () => {
    test('whenSecondObligationHandlerFailsThenBundleThrowsForbiddenException', async () => {
      const { service } = await createService([LogOnDecisionProvider, FailingRunnableProvider]);

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        obligations: [
          { type: 'logAccess' },
          { type: 'failingRunnable' },
        ],
      });

      expect(() => bundle.handleOnDecisionConstraints()).toThrow(ForbiddenException);
    });
  });

  describe('preEnforce vs postEnforce', () => {
    test('whenPostEnforceWithMethodInvocationAdviceThenHandlerIsNoOp', async () => {
      const { service } = await createService([InjectHeaderProvider]);

      const bundle = service.postEnforceBundleFor({
        decision: 'PERMIT',
        advice: [{ type: 'injectHeader', headerName: 'x-audit', value: 'injected' }],
      });

      const request = { headers: {}, params: {}, body: {} } as any;
      bundle.handleMethodInvocationHandlers(request);
      expect(request.headers['x-audit']).toBeUndefined();
    });

    test('whenPostEnforceWithMethodInvocationObligationThenUnhandled', async () => {
      const { service } = await createService([InjectHeaderProvider]);

      expect(() => service.postEnforceBundleFor({
        decision: 'PERMIT',
        obligations: [{ type: 'injectHeader', value: 'x' }],
      })).toThrow(ForbiddenException);
    });
  });

  describe('resource replacement', () => {
    test('whenDecisionHasResourceThenBundleReplacesOutput', async () => {
      const { service } = await createService();

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        resource: { replaced: true },
      });

      expect(bundle.handleAllOnNextConstraints({ original: true }))
        .toEqual({ replaced: true });
    });

    test('whenDecisionHasNoResourceThenOriginalValuePassesThrough', async () => {
      const { service } = await createService();
      const bundle = service.preEnforceBundleFor({ decision: 'PERMIT' });

      expect(bundle.handleAllOnNextConstraints({ original: true }))
        .toEqual({ original: true });
    });

    test('whenDecisionResourceIsExplicitNullThenReplacesValueWithNull', async () => {
      const { service } = await createService();

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        resource: null,
      });

      expect(bundle.handleAllOnNextConstraints({ original: true }))
        .toBeNull();
    });
  });

  describe('real-world: content filter through enforcement service', () => {
    test('whenBlackenSsnObligationThenPatientRecordMasked', async () => {
      const { service } = await createService([ContentFilteringProvider]);

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        obligations: [{
          type: 'filterJsonContent',
          actions: [{
            type: 'blacken',
            path: '$.ssn',
            replacement: '*',
            discloseRight: 4,
          }],
        }],
      });

      const result = bundle.handleAllOnNextConstraints({
        name: 'Jane Doe',
        ssn: '123-45-6789',
        diagnosis: 'healthy',
      });

      expect(result).toEqual({
        name: 'Jane Doe',
        ssn: '*******6789',
        diagnosis: 'healthy',
      });
    });

    test('whenFilterPredicateObligationThenOnlyMatchingRecordsReturned', async () => {
      const { service } = await createService([ContentFilterPredicateProvider]);

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        obligations: [{
          type: 'jsonContentFilterPredicate',
          conditions: [{ path: '$.status', type: '==', value: 'active' }],
        }],
      });

      const result = bundle.handleAllOnNextConstraints([
        { id: 1, status: 'active', name: 'A' },
        { id: 2, status: 'archived', name: 'B' },
        { id: 3, status: 'active', name: 'C' },
      ]);

      expect(result).toEqual([
        { id: 1, status: 'active', name: 'A' },
        { id: 3, status: 'active', name: 'C' },
      ]);
    });

    test('whenResourceReplacementAndContentFilterThenFilterAppliedToReplacedResource', async () => {
      const { service } = await createService([ContentFilteringProvider]);

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        resource: { name: 'Replaced Patient', ssn: '999-88-7777' },
        obligations: [{
          type: 'filterJsonContent',
          actions: [{ type: 'blacken', path: '$.ssn', replacement: '*', discloseRight: 4 }],
        }],
      });

      const result = bundle.handleAllOnNextConstraints({ name: 'Original', ssn: '111-22-3333' });

      expect(result).toEqual({
        name: 'Replaced Patient',
        ssn: '*******7777',
      });
    });

    test('whenBlackenObligationAndLoggingAdviceThenBothExecute', async () => {
      const { service, getProvider } = await createService([
        ContentFilteringProvider,
        AuditConsumerProvider,
      ]);

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        obligations: [{
          type: 'filterJsonContent',
          actions: [{ type: 'delete', path: '$.ssn' }],
        }],
        advice: [{ type: 'auditLog' }],
      });

      const result = bundle.handleAllOnNextConstraints({ name: 'Jane', ssn: '123' });

      expect(result).toEqual({ name: 'Jane' });
      expect(getProvider(AuditConsumerProvider).captured).toHaveLength(1);
    });
  });

  describe('advice handler types other than runnable', () => {
    test('whenMappingAdviceThenTransformsWithAdviceSemantics', async () => {
      const { service } = await createService([LowPriorityMappingProvider]);

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        advice: [{ type: 'addAuditField', user: 'system' }],
      });

      const result = bundle.handleAllOnNextConstraints({ data: 'x' });
      expect(result).toEqual({ data: 'x', auditedBy: 'system' });
    });

    test('whenFilterPredicateAdviceThenFiltersWithAdviceSemantics', async () => {
      const { service } = await createService([StatusFilterProvider]);

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        advice: [{ type: 'filterByStatus', requiredStatus: 'active' }],
      });

      const result = bundle.handleAllOnNextConstraints([
        { id: 1, status: 'active' },
        { id: 2, status: 'inactive' },
      ]);
      expect(result).toEqual([{ id: 1, status: 'active' }]);
    });

    test('whenConsumerAdviceThenInspectsWithAdviceSemantics', async () => {
      const { service, getProvider } = await createService([AuditConsumerProvider]);

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        advice: [{ type: 'auditLog' }],
      });

      bundle.handleAllOnNextConstraints({ data: 'test' });
      expect(getProvider(AuditConsumerProvider).captured).toEqual([{ data: 'test' }]);
    });

    test('whenErrorHandlerAdviceThenInspectsWithAdviceSemantics', async () => {
      const { service, getProvider } = await createService([ErrorAuditProvider]);

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        advice: [{ type: 'auditError' }],
      });

      const error = new Error('test');
      bundle.handleAllOnErrorConstraints(error);
      expect(getProvider(ErrorAuditProvider).captured).toEqual([error]);
    });

    test('whenErrorMappingAdviceThenTransformsWithAdviceSemantics', async () => {
      const { service } = await createService([ErrorEnrichmentProvider]);

      const bundle = service.preEnforceBundleFor({
        decision: 'PERMIT',
        advice: [{ type: 'enrichError' }],
      });

      const result = bundle.handleAllOnErrorConstraints(new Error('original'));
      expect(result.message).toBe('enriched: original');
    });
  });
});
