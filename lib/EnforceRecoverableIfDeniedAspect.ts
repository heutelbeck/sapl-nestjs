import { Logger } from '@nestjs/common';
import { Aspect, LazyDecorator, WrapParams } from '@toss/nestjs-aop';
import { ClsService } from 'nestjs-cls';
import { ENFORCE_RECOVERABLE_SYMBOL } from './EnforceRecoverableIfDenied';
import { EnforceRecoverableOptions } from './StreamingEnforceOptions';
import { PdpService } from './pdp.service';
import { buildContext, buildSubscriptionFromContext } from './SubscriptionBuilder';
import { ConstraintEnforcementService } from './constraints/ConstraintEnforcementService';
import { createStreamingEnforcement } from './StreamingEnforcementCore';

@Aspect(ENFORCE_RECOVERABLE_SYMBOL)
export class EnforceRecoverableIfDeniedAspect implements LazyDecorator<any, EnforceRecoverableOptions> {
  private readonly logger = new Logger(EnforceRecoverableIfDeniedAspect.name);

  constructor(
    private readonly pdpService: PdpService,
    private readonly cls: ClsService,
    private readonly constraintService: ConstraintEnforcementService,
  ) {}

  wrap({ method, metadata, methodName, instance }: WrapParams<any, EnforceRecoverableOptions>) {
    const aspect = this;
    const className = instance.constructor.name;

    return (...args: any[]) => {
      const ctx = buildContext(aspect.cls, methodName, className, args);
      const subscription = buildSubscriptionFromContext(metadata, ctx);
      const decisions$ = aspect.pdpService.decide(subscription);

      return createStreamingEnforcement(method, args, decisions$, aspect.constraintService, {
        terminalOnDeny: false,
        onStreamDeny: metadata.onStreamDeny,
        onStreamRecover: metadata.onStreamRecover,
      }, aspect.logger);
    };
  }

}
