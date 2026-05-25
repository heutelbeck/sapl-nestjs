import { Logger } from '@nestjs/common';
import { Aspect, LazyDecorator, WrapParams } from '@toss/nestjs-aop';
import { ClsService } from 'nestjs-cls';
import { PRE_ENFORCE_SYMBOL } from './PreEnforce';
import { SubscriptionOptions } from './SubscriptionOptions';
import { EnforcementPlanner } from './constraints/Planner';
import { EnforcementPlan } from './constraints/Plan';
import type { SignalKind } from './constraints/Signal';
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
    const plan = this.planner.plan(decision, PRE_SIGNALS);

    const decisionResult = plan.execute({ kind: 'decision', value: decision });
    if (decisionResult.failureState) {
      this.logger.warn('Decision-scoped constraint enforcement failed on PERMIT');
      throw new AccessDeniedError('Decision-scoped obligation enforcement failed');
    }

    const inputResult = plan.execute({ kind: 'input', value: args });
    if (inputResult.failureState) {
      this.logger.warn('Input constraint enforcement failed on PERMIT');
      throw new AccessDeniedError('Input obligation enforcement failed');
    }
    const effectiveArgs =
      inputResult.value.kind === 'present' && Array.isArray(inputResult.value.value)
        ? (inputResult.value.value as unknown[])
        : args;

    const invokeAndEnforce = async () => {
      let result;
      try {
        result = await method(...effectiveArgs);
      } catch (methodError) {
        const asError = methodError instanceof Error ? methodError : new Error(String(methodError));
        const errorResult = plan.execute({ kind: 'error', value: asError });
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
    const outputResult = plan.execute({ kind: 'output', value: result });
    if (outputResult.failureState) {
      this.logger.warn('Output constraint enforcement failed on PERMIT');
      throw new AccessDeniedError('Output obligation enforcement failed');
    }
    return outputResult.value.kind === 'present' ? outputResult.value.value : null;
  }
}
