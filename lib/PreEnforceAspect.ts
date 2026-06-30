import { Logger } from '@nestjs/common';
import { Aspect, LazyDecorator, WrapParams } from '@toss/nestjs-aop';
import { ClsService } from 'nestjs-cls';
import { PRE_ENFORCE_SYMBOL } from './PreEnforce';
import { SubscriptionOptions } from './SubscriptionOptions';
import { EnforcementPlanner } from './constraints/Planner';
import { EnforcementPlan } from './constraints/Plan';
import type { Signal, SignalKind } from './constraints/Signal';
import { shimSignals } from './constraints/ShimSignalRegistry';
import { setActivePlan } from './constraints/ActivePlan';
import { PdpService } from './pdp.service';
import { buildContext, buildSubscriptionFromContext } from './SubscriptionBuilder';
import { handleDeny } from './enforcement-utils';
import { SaplTransactionAdapter } from './SaplTransactionAdapter';
import { AccessDeniedError } from './streaming/BoundarySignals';
import type { AuthorizationDecision } from './types';

const PRE_SIGNALS: ReadonlySet<SignalKind> = new Set<SignalKind>(['decision', 'input', 'output', 'error']);

@Aspect(PRE_ENFORCE_SYMBOL)
export class PreEnforceAspect implements LazyDecorator<any, SubscriptionOptions> {
  private readonly logger = new Logger(PreEnforceAspect.name);

  constructor(
    private readonly pdpService: PdpService,
    private readonly cls: ClsService,
    private readonly planner: EnforcementPlanner,
    private readonly transactionAdapter: SaplTransactionAdapter,
  ) {}

  wrap({ method, metadata, methodName, instance }: WrapParams<any, SubscriptionOptions>) {
    const className = instance.constructor.name;

    return async (...args: any[]) => {
      const context = buildContext(this.cls, methodName, className, args);
      const subscription = buildSubscriptionFromContext(metadata, context);
      const { secrets: _secrets, ...safeForLog } = subscription;
      this.logger.debug(`Subscription: ${JSON.stringify(safeForLog)}`);

      const decision = await this.pdpService.decideOnce(subscription);
      this.logger.debug(`Decision: ${JSON.stringify(decision)}`);

      if (decision.decision === 'PERMIT') {
        return this.handlePermit(decision, method, args);
      }

      handleDeny(this.logger, this.planner, decision);
    };
  }

  private async handlePermit(
    decision: AuthorizationDecision,
    method: (...args: any[]) => any,
    args: any[],
  ): Promise<any> {
    const supportedSignals = new Set<SignalKind>([...PRE_SIGNALS, ...shimSignals()]);
    const plan = this.planner.plan(decision, supportedSignals);

    // Fire decision then input unconditionally so input-scoped handlers
    // still run even when a decision-scoped obligation already failed,
    // then deny once if any pre-invocation obligation failed.
    const decisionResult = plan.execute({ kind: 'decision', value: decision });
    const inputResult = plan.execute({ kind: 'input', value: args }, decisionResult.failureState);
    if (inputResult.failureState) {
      this.logger.warn('Pre-invocation constraint enforcement failed on PERMIT');
      throw new AccessDeniedError(
        'Pre-invocation obligation enforcement failed. The protected method was not invoked.',
      );
    }
    const effectiveArgs =
      inputResult.value.kind === 'present' && Array.isArray(inputResult.value.value)
        ? (inputResult.value.value as unknown[])
        : args;

    const invokeAndEnforce = async () => {
      // Expose the plan to data-layer shims (Mongoose/Prisma) that
      // discharge their query-manipulation signal during the method's
      // DB calls. CLS propagates it across the awaited async context.
      setActivePlan(this.cls, plan);
      let result;
      try {
        result = await method(...effectiveArgs);
      } catch (methodError) {
        const asError = methodError instanceof Error ? methodError : new Error(String(methodError));
        const errorResult = plan.execute({ kind: 'error', value: asError });
        // Error-signal enforcement is itself fail-closed: a failed error
        // obligation (e.g. audit/scrubbing) escalates to deny rather than
        // letting the raw method error reach the caller.
        if (errorResult.failureState) {
          this.logger.warn('Error-signal constraint enforcement failed on PERMIT');
          throw new AccessDeniedError('Error-signal obligation enforcement failed');
        }
        if (errorResult.value.kind === 'present' && errorResult.value.value instanceof Error) {
          throw errorResult.value.value;
        }
        throw asError;
      }
      return this.applyOutput(plan, result);
    };

    if (this.transactionAdapter.isActive) {
      return this.transactionAdapter.withTransaction(invokeAndEnforce);
    }
    return invokeAndEnforce();
  }

  private applyOutput(plan: EnforcementPlan, result: unknown): unknown {
    // A void return fires the output signal empty (no value), so Mappers
    // and Consumers are skipped and only Runners fire.
    const signal: Signal = result === undefined ? { kind: 'output' } : { kind: 'output', value: result };
    const outputResult = plan.execute(signal);
    if (outputResult.failureState) {
      this.logger.warn('Post-invocation constraint enforcement failed on PERMIT');
      throw new AccessDeniedError(
        'Post-invocation obligation enforcement failed. The protected method already executed and its side effects may have occurred.',
      );
    }
    return outputResult.value.kind === 'present' ? outputResult.value.value : null;
  }
}
