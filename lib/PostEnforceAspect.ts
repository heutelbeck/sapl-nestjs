import { Logger } from '@nestjs/common';
import { Aspect, LazyDecorator, WrapParams } from '@toss/nestjs-aop';
import { ClsService } from 'nestjs-cls';
import { POST_ENFORCE_SYMBOL } from './PostEnforce';
import { EnforceOptions } from './EnforceOptions';
import { PdpService } from './pdp.service';
import { buildContext, buildSubscriptionFromContext } from './SubscriptionBuilder';
import { SubscriptionContext } from './SubscriptionContext';
import { ConstraintEnforcementService } from './constraints/ConstraintEnforcementService';
import { handleDeny, applyDeny } from './enforcement-utils';
import { SaplTransactionAdapter } from './SaplTransactionAdapter';

@Aspect(POST_ENFORCE_SYMBOL)
export class PostEnforceAspect implements LazyDecorator<any, EnforceOptions> {
  private readonly logger = new Logger(PostEnforceAspect.name);

  constructor(
    private readonly pdpService: PdpService,
    private readonly cls: ClsService,
    private readonly constraintService: ConstraintEnforcementService,
    private readonly transactionAdapter: SaplTransactionAdapter,
  ) {}

  wrap({ method, metadata, methodName, instance }: WrapParams<any, EnforceOptions>) {
    const aspect = this;
    const className = instance.constructor.name;

    return async (...args: any[]) => {
      const executeAndEnforce = async () => {
        const handlerResult = await method(...args);

        const ctx = buildContext(aspect.cls, methodName, className, args);
        ctx.returnValue = handlerResult;

        const subscription = buildSubscriptionFromContext(metadata, ctx);
        const { secrets, ...safeForLog } = subscription;
        aspect.logger.debug(`Subscription: ${JSON.stringify(safeForLog)}`);

        const decision = await aspect.pdpService.decideOnce(subscription);
        aspect.logger.debug(`Decision: ${JSON.stringify(decision)}`);

        if (decision.decision === 'PERMIT') {
          return aspect.handlePermit(decision, metadata, ctx, handlerResult);
        }

        return handleDeny(aspect.logger, aspect.constraintService, decision, metadata, ctx);
      };

      if (aspect.transactionAdapter.isActive) {
        return aspect.transactionAdapter.withTransaction(executeAndEnforce);
      }
      return executeAndEnforce();
    };
  }

  private handlePermit(
    decision: any,
    options: EnforceOptions,
    ctx: SubscriptionContext,
    handlerResult: any,
  ): any {
    let bundle;
    try {
      bundle = this.constraintService.postEnforceBundleFor(decision);
    } catch (error) {
      this.logger.warn(`Obligation handling failed on PERMIT: ${error}`);
      return applyDeny(options, ctx, decision);
    }

    try {
      bundle.handleOnDecisionConstraints();
      return bundle.handleAllOnNextConstraints(handlerResult);
    } catch (error) {
      const asError = error instanceof Error ? error : new Error(String(error));
      let mappedError: Error = asError;
      try {
        mappedError = bundle.handleAllOnErrorConstraints(asError);
      } catch (handlerError) {
        this.logger.warn(`Error handler failed while handling obligation failure: ${handlerError}`);
      }
      this.logger.warn(`Obligation handling failed on PERMIT: ${mappedError}`);
      return applyDeny(options, ctx, decision);
    }
  }

}
