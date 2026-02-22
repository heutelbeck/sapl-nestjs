import { ForbiddenException, Logger } from '@nestjs/common';
import { Aspect, LazyDecorator, WrapParams } from '@toss/nestjs-aop';
import { ClsService, CLS_REQ } from 'nestjs-cls';
import { POST_ENFORCE_SYMBOL } from './PostEnforce';
import { EnforceOptions } from './EnforceOptions';
import { PdpService } from './pdp.service';
import { SubscriptionContext } from './SubscriptionContext';
import { buildSubscriptionFromContext } from './SubscriptionBuilder';
import { ConstraintEnforcementService } from './constraints/ConstraintEnforcementService';

@Aspect(POST_ENFORCE_SYMBOL)
export class PostEnforceAspect implements LazyDecorator<any, EnforceOptions> {
  private readonly logger = new Logger(PostEnforceAspect.name);

  constructor(
    private readonly pdpService: PdpService,
    private readonly cls: ClsService,
    private readonly constraintService: ConstraintEnforcementService,
  ) {}

  wrap({ method, metadata, methodName, instance }: WrapParams<any, EnforceOptions>) {
    const aspect = this;
    const className = instance.constructor.name;

    return async (...args: any[]) => {
      const handlerResult = await method(...args);

      const ctx = aspect.buildContext(methodName, className, args);
      ctx.returnValue = handlerResult;

      const subscription = buildSubscriptionFromContext(metadata, ctx);
      const { secrets, ...safeForLog } = subscription;
      aspect.logger.debug(`Subscription: ${JSON.stringify(safeForLog)}`);

      const decision = await aspect.pdpService.decideOnce(subscription);
      aspect.logger.debug(`Decision: ${JSON.stringify(decision)}`);

      if (decision.decision === 'PERMIT') {
        return aspect.handlePermit(decision, metadata, ctx, handlerResult);
      }

      return aspect.handleDeny(decision, metadata, ctx);
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
      return this.deny(options, ctx, decision);
    }

    try {
      bundle.handleOnDecisionConstraints();
      return bundle.handleAllOnNextConstraints(handlerResult);
    } catch (error) {
      try { bundle.handleAllOnErrorConstraints(error instanceof Error ? error : new Error(String(error))); } catch { /* already denying */ }
      this.logger.warn(`Obligation handling failed on PERMIT: ${error}`);
      return this.deny(options, ctx, decision);
    }
  }

  private handleDeny(
    decision: any,
    options: EnforceOptions,
    ctx: SubscriptionContext,
  ): any {
    if (decision.decision === 'INDETERMINATE') {
      this.logger.error(`PDP returned INDETERMINATE -- PDP may be unreachable or misconfigured`);
    } else {
      this.logger.warn(`Access denied: ${decision.decision}`);
    }

    try {
      const bundle = this.constraintService.bestEffortBundleFor(decision);
      bundle.handleOnDecisionConstraints();
    } catch (error) {
      this.logger.warn(`Best-effort obligation handlers failed on ${decision.decision}: ${error}`);
    }

    return this.deny(options, ctx, decision);
  }

  private deny(options: EnforceOptions, ctx: SubscriptionContext, decision: any): any {
    if (options.onDeny) {
      return options.onDeny(ctx, decision);
    }
    throw new ForbiddenException('Access denied by policy');
  }

  private buildContext(methodName: string, className: string, args: any[]): SubscriptionContext {
    const request = this.cls.get(CLS_REQ) ?? {};
    return {
      request,
      params: request.params ?? {},
      query: request.query ?? {},
      body: request.body,
      handler: methodName,
      controller: className,
      args,
    };
  }
}
