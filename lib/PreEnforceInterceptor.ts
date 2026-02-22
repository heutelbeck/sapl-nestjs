import { CallHandler, ExecutionContext, ForbiddenException, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of, from, map, catchError } from 'rxjs';
import { PRE_ENFORCE_KEY } from './PreEnforce';
import { EnforceOptions } from './EnforceOptions';
import { PdpService } from './pdp.service';
import { buildContext, buildSubscriptionFromContext } from './SubscriptionBuilder';
import { ConstraintEnforcementService } from './constraints/ConstraintEnforcementService';

@Injectable()
export class PreEnforceInterceptor implements NestInterceptor {
  private readonly logger = new Logger(PreEnforceInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly pdpService: PdpService,
    private readonly constraintService: ConstraintEnforcementService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const options = this.reflector.get<EnforceOptions>(
      PRE_ENFORCE_KEY,
      context.getHandler(),
    );

    if (!options) {
      return next.handle();
    }

    const ctx = buildContext(context);
    const request = context.switchToHttp().getRequest();
    const subscription = buildSubscriptionFromContext(options, ctx);
    const { secrets, ...safeForLog } = subscription;
    this.logger.debug(`Subscription: ${JSON.stringify(safeForLog)}`);

    const decision = await this.pdpService.decideOnce(subscription);
    this.logger.debug(`Decision: ${JSON.stringify(decision)}`);

    if (decision.decision === 'PERMIT') {
      return this.handlePermit(decision, options, ctx, request, next);
    }

    return this.handleDeny(decision, options, ctx);
  }

  private handlePermit(
    decision: any,
    options: EnforceOptions,
    ctx: any,
    request: any,
    next: CallHandler,
  ): Observable<any> {
    let bundle;
    try {
      bundle = this.constraintService.preEnforceBundleFor(decision);
    } catch (error) {
      this.logger.warn(`Obligation handling failed on PERMIT: ${error}`);
      return this.deny(options, ctx, decision);
    }

    try {
      bundle.handleOnDecisionConstraints();
      bundle.handleMethodInvocationHandlers(request);

      return next.handle().pipe(
        map((value) => bundle.handleAllOnNextConstraints(value)),
        catchError((error) => {
          throw bundle.handleAllOnErrorConstraints(error);
        }),
      );
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
  ): Observable<any> {
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

  private deny(options: EnforceOptions, ctx: any, decision: any): Observable<any> {
    if (options.onDeny) {
      const result = options.onDeny(ctx, decision);
      return result instanceof Promise ? from(result) : of(result);
    }
    throw new ForbiddenException('Access denied by policy');
  }
}
