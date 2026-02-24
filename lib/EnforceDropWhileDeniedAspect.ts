import { Logger } from '@nestjs/common';
import { Aspect, LazyDecorator, WrapParams } from '@toss/nestjs-aop';
import { ClsService } from 'nestjs-cls';
import { Observable, Subscription } from 'rxjs';
import { ENFORCE_DROP_WHILE_DENIED_SYMBOL } from './EnforceDropWhileDenied';
import { EnforceDropWhileDeniedOptions } from './StreamingEnforceOptions';
import { PdpService } from './pdp.service';
import { SubscriptionContext } from './SubscriptionContext';
import { buildContext, buildSubscriptionFromContext } from './SubscriptionBuilder';
import { ConstraintEnforcementService } from './constraints/ConstraintEnforcementService';
import { StreamingConstraintHandlerBundle } from './constraints/StreamingConstraintHandlerBundle';

@Aspect(ENFORCE_DROP_WHILE_DENIED_SYMBOL)
export class EnforceDropWhileDeniedAspect implements LazyDecorator<any, EnforceDropWhileDeniedOptions> {
  private readonly logger = new Logger(EnforceDropWhileDeniedAspect.name);

  constructor(
    private readonly pdpService: PdpService,
    private readonly cls: ClsService,
    private readonly constraintService: ConstraintEnforcementService,
  ) {}

  wrap({ method, metadata, methodName, instance }: WrapParams<any, EnforceDropWhileDeniedOptions>) {
    const aspect = this;
    const className = instance.constructor.name;

    return (...args: any[]) => {
      const source$ = method(...args);

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
                permitted = false;
                currentBundle = null;
                return;
              }
              permitted = true;

              if (!sourceSubscription) {
                sourceSubscription = source$.subscribe({
                  next: (value: any) => {
                    if (!permitted || !currentBundle) return;
                    try {
                      const transformed = currentBundle.handleAllOnNextConstraints(value);
                      subscriber.next(transformed);
                    } catch (error) {
                      aspect.logger.warn(`Constraint handling failed on next: ${error}`);
                      permitted = false;
                      currentBundle = null;
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
