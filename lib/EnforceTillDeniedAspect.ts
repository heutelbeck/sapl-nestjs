import { Logger } from '@nestjs/common';
import { Aspect, LazyDecorator, WrapParams } from '@toss/nestjs-aop';
import { ClsService } from 'nestjs-cls';
import { ENFORCE_TILL_DENIED_SYMBOL } from './EnforceTillDenied';
import { EnforceTillDeniedOptions } from './StreamingEnforceOptions';
import { PdpService } from './pdp.service';
import { buildContext, buildSubscriptionFromContext } from './SubscriptionBuilder';
import { ConstraintEnforcementService } from './constraints/ConstraintEnforcementService';
import { createStreamingEnforcement } from './StreamingEnforcementCore';

@Aspect(ENFORCE_TILL_DENIED_SYMBOL)
export class EnforceTillDeniedAspect implements LazyDecorator<any, EnforceTillDeniedOptions> {
  private readonly logger = new Logger(EnforceTillDeniedAspect.name);

  constructor(
    private readonly pdpService: PdpService,
    private readonly cls: ClsService,
    private readonly constraintService: ConstraintEnforcementService,
  ) {}

  wrap({ method, metadata, methodName, instance }: WrapParams<any, EnforceTillDeniedOptions>) {
    const aspect = this;
    const className = instance.constructor.name;

    return (...args: any[]) => {
      const ctx = buildContext(aspect.cls, methodName, className, args);
      const subscription = buildSubscriptionFromContext(metadata, ctx);
      const decisions$ = aspect.pdpService.decide(subscription);

      return createStreamingEnforcement(method, args, decisions$, aspect.constraintService, {
        terminalOnDeny: true,
        onStreamDeny: metadata.onStreamDeny,
      }, aspect.logger);
    };
  }

}
