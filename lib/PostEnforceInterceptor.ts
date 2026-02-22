import { CallHandler, ExecutionContext, ForbiddenException, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, switchMap } from 'rxjs';
import { POST_ENFORCE_KEY } from './PostEnforce';
import { EnforceOptions } from './EnforceOptions';
import { PdpService } from './pdp.service';
import { buildContext, buildSubscriptionFromContext } from './SubscriptionBuilder';
import { ConstraintEnforcementService } from './constraints/ConstraintEnforcementService';

@Injectable()
export class PostEnforceInterceptor implements NestInterceptor {
  private readonly logger = new Logger(PostEnforceInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly pdpService: PdpService,
    private readonly constraintService: ConstraintEnforcementService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const options = this.reflector.get<EnforceOptions>(
      POST_ENFORCE_KEY,
      context.getHandler(),
    );

    if (!options) {
      return next.handle();
    }

    return next.handle().pipe(
      switchMap(async (handlerResult) => {
        const ctx = buildContext(context);
        ctx.returnValue = handlerResult;

        const subscription = buildSubscriptionFromContext(options, ctx);
        this.logger.debug(`Subscription: ${JSON.stringify(subscription)}`);

        const decision = await this.pdpService.decideOnce(subscription);
        this.logger.debug(`Decision: ${JSON.stringify(decision)}`);

        if (decision.decision === 'PERMIT') {
          return this.handlePermit(decision, options, ctx, handlerResult);
        }

        return this.handleDeny(decision, options, ctx);
      }),
    );
  }

  private handlePermit(
    decision: any,
    options: EnforceOptions,
    ctx: any,
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
    ctx: any,
  ): any {
    this.logger.warn(`Access denied: ${decision.decision}`);

    try {
      const bundle = this.constraintService.bestEffortBundleFor(decision);
      bundle.handleOnDecisionConstraints();
    } catch (error) {
      this.logger.warn(`Best-effort obligation handlers failed on ${decision.decision}: ${error}`);
    }

    return this.deny(options, ctx, decision);
  }

  private deny(options: EnforceOptions, ctx: any, decision: any): any {
    if (options.onDeny && ctx) {
      return options.onDeny(ctx, decision);
    }
    throw new ForbiddenException('Access denied by policy');
  }
}
