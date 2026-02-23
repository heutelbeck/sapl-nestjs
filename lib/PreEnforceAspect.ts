import { ForbiddenException, Logger } from '@nestjs/common';
import { Aspect, LazyDecorator, WrapParams } from '@toss/nestjs-aop';
import { ClsService, CLS_REQ } from 'nestjs-cls';
import { PRE_ENFORCE_SYMBOL } from './PreEnforce';
import { EnforceOptions } from './EnforceOptions';
import { MethodInvocationContext } from './MethodInvocationContext';
import { PdpService } from './pdp.service';
import { SubscriptionContext } from './SubscriptionContext';
import { buildSubscriptionFromContext } from './SubscriptionBuilder';
import { ConstraintEnforcementService } from './constraints/ConstraintEnforcementService';

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
      const ctx = aspect.buildContext(methodName, className, args);
      const subscription = buildSubscriptionFromContext(metadata, ctx);
      const { secrets, ...safeForLog } = subscription;
      aspect.logger.debug(`Subscription: ${JSON.stringify(safeForLog)}`);

      const decision = await aspect.pdpService.decideOnce(subscription);
      aspect.logger.debug(`Decision: ${JSON.stringify(decision)}`);

      if (decision.decision === 'PERMIT') {
        return aspect.handlePermit(decision, metadata, ctx, method, args, methodName, className);
      }

      return aspect.handleDeny(decision, metadata, ctx);
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
      return this.deny(options, ctx, decision);
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
      return this.deny(options, ctx, decision);
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
            return this.deny(options, ctx, decision);
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
