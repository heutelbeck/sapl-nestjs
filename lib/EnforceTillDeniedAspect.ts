import { ForbiddenException, Logger } from '@nestjs/common';
import { Aspect, LazyDecorator, WrapParams } from '@toss/nestjs-aop';
import { ClsService } from 'nestjs-cls';
import { Observable, Subscription } from 'rxjs';
import { ENFORCE_TILL_DENIED_SYMBOL } from './EnforceTillDenied';
import { EnforceTillDeniedOptions } from './StreamingEnforceOptions';
import { PdpService } from './pdp.service';
import { SubscriptionContext } from './SubscriptionContext';
import { buildContext, buildSubscriptionFromContext } from './SubscriptionBuilder';
import { ConstraintEnforcementService } from './constraints/ConstraintEnforcementService';
import { StreamingConstraintHandlerBundle } from './constraints/StreamingConstraintHandlerBundle';

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
      return new Observable((subscriber) => {
        let currentBundle: StreamingConstraintHandlerBundle | null = null;
        let sourceSubscription: Subscription | null = null;
        let permitted = false;

        const ctx = buildContext(aspect.cls, methodName, className, args);
        const subscription = buildSubscriptionFromContext(metadata, ctx);
        const decisions$ = aspect.pdpService.decide(subscription);

        const decisionSub = decisions$.subscribe({
          next: (decision) => {
            if (decision.decision === 'PERMIT') {
              try {
                const newBundle = aspect.constraintService.streamingBundleFor(decision);
                newBundle.handleOnDecisionConstraints();
                currentBundle = newBundle;
              } catch (error) {
                aspect.logger.warn(`Obligation handling failed: ${error}`);
                try {
                  metadata.onStreamDeny?.(decision, subscriber);
                } catch (callbackError) {
                  aspect.logger.warn(`onStreamDeny callback failed: ${callbackError}`);
                }
                subscriber.error(new ForbiddenException('Access denied by policy'));
                return;
              }
              permitted = true;

              if (!sourceSubscription) {
                sourceSubscription = method(...args).subscribe({
                  next: (value: any) => {
                    if (!permitted || !currentBundle) return;
                    try {
                      const transformed = currentBundle.handleAllOnNextConstraints(value);
                      subscriber.next(transformed);
                    } catch (error) {
                      aspect.logger.warn(`Constraint handling failed on next: ${error}`);
                      subscriber.error(new ForbiddenException('Constraint handling failed'));
                    }
                  },
                  error: (err: any) => subscriber.error(err),
                  complete: () => {
                    currentBundle?.handleOnCompleteConstraints();
                    subscriber.complete();
                  },
                });
              }
            } else {
              permitted = false;
              try {
                const bestEffort = aspect.constraintService.streamingBestEffortBundleFor(decision);
                bestEffort.handleOnDecisionConstraints();
              } catch {
                /* best effort */
              }
              try {
                metadata.onStreamDeny?.(decision, subscriber);
              } catch (callbackError) {
                aspect.logger.warn(`onStreamDeny callback failed: ${callbackError}`);
              }
              subscriber.error(new ForbiddenException('Access denied by policy'));
            }
          },
          error: (err) => subscriber.error(err),
        });

        return () => {
          currentBundle?.handleOnCancelConstraints();
          decisionSub.unsubscribe();
          sourceSubscription?.unsubscribe();
        };
      });
    };
  }

}
