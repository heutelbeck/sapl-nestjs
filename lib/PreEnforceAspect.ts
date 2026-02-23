import { Logger } from '@nestjs/common';
import { Aspect, LazyDecorator, WrapParams } from '@toss/nestjs-aop';
import { ClsService } from 'nestjs-cls';
import { PRE_ENFORCE_SYMBOL } from './PreEnforce';
import { EnforceOptions } from './EnforceOptions';
import { MethodInvocationContext } from './MethodInvocationContext';
import { PdpService } from './pdp.service';
import { buildContext, buildSubscriptionFromContext } from './SubscriptionBuilder';
import { SubscriptionContext } from './SubscriptionContext';
import { ConstraintEnforcementService } from './constraints/ConstraintEnforcementService';
import { handleDeny, applyDeny } from './enforcement-utils';

@Aspect(PRE_ENFORCE_SYMBOL)
export class PreEnforceAspect implements LazyDecorator<any, EnforceOptions> {
  private readonly logger = new Logger(PreEnforceAspect.name);

  constructor(
    private readonly pdpService: PdpService,
    private readonly cls: ClsService,
    private readonly constraintService: ConstraintEnforcementService,
  ) {}

  wrap({ method, metadata, methodName, instance }: WrapParams<any, EnforceOptions>) {
    const aspect = this;
    const className = instance.constructor.name;

    return async (...args: any[]) => {
      const ctx = buildContext(aspect.cls, methodName, className, args);
      const subscription = buildSubscriptionFromContext(metadata, ctx);
      const { secrets, ...safeForLog } = subscription;
      aspect.logger.debug(`Subscription: ${JSON.stringify(safeForLog)}`);

      const decision = await aspect.pdpService.decideOnce(subscription);
      aspect.logger.debug(`Decision: ${JSON.stringify(decision)}`);

      if (decision.decision === 'PERMIT') {
        return aspect.handlePermit(decision, metadata, ctx, method, args, methodName, className);
      }

      return handleDeny(aspect.logger, aspect.constraintService, decision, metadata, ctx);
    };
  }

  private handlePermit(
    decision: any,
    options: EnforceOptions,
    ctx: SubscriptionContext,
    method: (...args: any[]) => any,
    args: any[],
    methodName: string,
    className: string,
  ): any {
    let bundle;
    try {
      bundle = this.constraintService.preEnforceBundleFor(decision);
    } catch (error) {
      this.logger.warn(`Obligation handling failed on PERMIT: ${error}`);
      return applyDeny(options, ctx, decision);
    }

    // Phase 1: pre-method obligation handlers -- failure denies access
    const invocationContext: MethodInvocationContext = {
      request: ctx.request,
      args,
      methodName,
      className,
    };
    try {
      bundle.handleOnDecisionConstraints();
      bundle.handleMethodInvocationHandlers(invocationContext);
    } catch (error) {
      this.logger.warn(`Obligation handling failed on PERMIT: ${error}`);
      return applyDeny(options, ctx, decision);
    }

    // Phase 2: method execution -- errors propagate after error handler mapping
    let result;
    try {
      result = method(...invocationContext.args);
    } catch (methodError) {
      throw bundle.handleAllOnErrorConstraints(
        methodError instanceof Error ? methodError : new Error(String(methodError)),
      );
    }

    // Phase 3: post-method obligation handlers -- failure denies access
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          try {
            return bundle.handleAllOnNextConstraints(value);
          } catch (obligationError) {
            this.logger.warn(`Obligation handling failed on PERMIT: ${obligationError}`);
            return applyDeny(options, ctx, decision);
          }
        },
        (methodError) => {
          throw bundle.handleAllOnErrorConstraints(
            methodError instanceof Error ? methodError : new Error(String(methodError)),
          );
        },
      );
    }

    try {
      return bundle.handleAllOnNextConstraints(result);
    } catch (obligationError) {
      this.logger.warn(`Obligation handling failed on PERMIT: ${obligationError}`);
      return applyDeny(options, ctx, decision);
    }
  }

}
