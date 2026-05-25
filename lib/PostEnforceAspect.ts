import { Logger } from '@nestjs/common';
import { AccessDeniedError } from './streaming/BoundarySignals';
import { Aspect, LazyDecorator, WrapParams } from '@toss/nestjs-aop';
import { ClsService } from 'nestjs-cls';
import { POST_ENFORCE_SYMBOL } from './PostEnforce';
import { SubscriptionOptions } from './SubscriptionOptions';
import { EnforcementPlanner } from './constraints/Planner';
import type { SignalKind } from './constraints/Signal';
import { PdpService } from './pdp.service';
import { buildContext, buildSubscriptionFromContext } from './SubscriptionBuilder';
import { handleDeny } from './enforcement-utils';
import { SaplTransactionAdapter } from './SaplTransactionAdapter';
import type { AuthorizationDecision } from './types';

const POST_SIGNALS: ReadonlySet<SignalKind> = new Set<SignalKind>(['decision', 'output', 'error']);

@Aspect(POST_ENFORCE_SYMBOL)
export class PostEnforceAspect implements LazyDecorator<any, SubscriptionOptions> {
  private readonly logger = new Logger(PostEnforceAspect.name);

  constructor(
    private readonly pdpService: PdpService,
    private readonly cls: ClsService,
    private readonly planner: EnforcementPlanner,
    private readonly transactionAdapter: SaplTransactionAdapter,
  ) {}

  wrap({ method, metadata, methodName, instance }: WrapParams<any, SubscriptionOptions>) {
    const className = instance.constructor.name;

    return async (...args: any[]) => {
      const executeAndEnforce = async () => {
        const handlerResult = await method(...args);

        const context = buildContext(this.cls, methodName, className, args);
        context.returnValue = handlerResult;

        const subscription = buildSubscriptionFromContext(metadata, context);
        const { secrets: _secrets, ...safeForLog } = subscription;
        this.logger.debug(`Subscription: ${JSON.stringify(safeForLog)}`);

        const decision = await this.pdpService.decideOnce(subscription);
        this.logger.debug(`Decision: ${JSON.stringify(decision)}`);

        if (decision.decision === 'PERMIT') {
          return this.handlePermit(decision, handlerResult);
        }

        handleDeny(this.logger, this.planner, decision);
      };

      if (this.transactionAdapter.isActive) {
        return this.transactionAdapter.withTransaction(executeAndEnforce);
      }
      return executeAndEnforce();
    };
  }

  private handlePermit(decision: AuthorizationDecision, handlerResult: unknown): unknown {
    const plan = this.planner.plan(decision, POST_SIGNALS);

    const decisionResult = plan.execute({ kind: 'decision', value: decision });
    if (decisionResult.failureState) {
      this.logger.warn('Decision-scoped constraint enforcement failed on PERMIT');
      throw new AccessDeniedError('Decision-scoped obligation enforcement failed');
    }

    const outputResult = plan.execute({ kind: 'output', value: handlerResult });
    if (outputResult.failureState) {
      this.logger.warn('Output constraint enforcement failed on PERMIT');
      throw new AccessDeniedError('Output obligation enforcement failed');
    }
    return outputResult.value.kind === 'present' ? outputResult.value.value : null;
  }
}
