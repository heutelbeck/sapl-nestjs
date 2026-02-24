import { Logger } from '@nestjs/common';
import { Aspect, LazyDecorator, WrapParams } from '@toss/nestjs-aop';
import { ClsService } from 'nestjs-cls';
import { Observable, Subscription } from 'rxjs';
import { ENFORCE_RECOVERABLE_SYMBOL } from './EnforceRecoverableIfDenied';
import { EnforceRecoverableOptions } from './StreamingEnforceOptions';
import { PdpService } from './pdp.service';
import { SubscriptionContext } from './SubscriptionContext';
import { buildContext, buildSubscriptionFromContext } from './SubscriptionBuilder';
import { ConstraintEnforcementService } from './constraints/ConstraintEnforcementService';
import { StreamingConstraintHandlerBundle } from './constraints/StreamingConstraintHandlerBundle';

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
      return new Observable((subscriber) => {
        let currentBundle: StreamingConstraintHandlerBundle | null = null;
        let sourceSubscription: Subscription | null = null;
        let accessState: 'initial' | 'permitted' | 'denied' = 'initial';

        const ctx = buildContext(aspect.cls, methodName, className, args);
        const subscription = buildSubscriptionFromContext(metadata, ctx);
        const decisions$ = aspect.pdpService.decide(subscription);

        const decisionSub = decisions$.subscribe({
          next: (decision) => {
            const previousState = accessState;

            if (decision.decision === 'PERMIT') {
              try {
                const newBundle = aspect.constraintService.streamingBundleFor(decision);
                newBundle.handleOnDecisionConstraints();
                currentBundle = newBundle;
              } catch (error) {
                aspect.logger.warn(`Obligation handling failed: ${error}`);
                accessState = 'denied';
                currentBundle = null;
                if (previousState !== 'denied') {
                  try {
                    metadata.onStreamDeny?.(decision, subscriber);
                  } catch (callbackError) {
                    aspect.logger.warn(`onStreamDeny callback failed: ${callbackError}`);
                  }
                }
                return;
              }
              accessState = 'permitted';

              if (previousState === 'denied') {
                try {
                  metadata.onStreamRecover?.(decision, subscriber);
                } catch (callbackError) {
                  aspect.logger.warn(`onStreamRecover callback failed: ${callbackError}`);
                }
              }

              if (!sourceSubscription) {
                sourceSubscription = method(...args).subscribe({
                  next: (value: any) => {
                    if (accessState !== 'permitted' || !currentBundle) return;
                    try {
                      const transformed = currentBundle.handleAllOnNextConstraints(value);
                      subscriber.next(transformed);
                    } catch (error) {
                      aspect.logger.warn(`Constraint handling failed on next: ${error}`);
                      accessState = 'denied';
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
              accessState = 'denied';
              try {
                const bestEffort = aspect.constraintService.streamingBestEffortBundleFor(decision);
                bestEffort.handleOnDecisionConstraints();
              } catch {
                /* best effort */
              }

              if (previousState !== 'denied') {
                try {
                  metadata.onStreamDeny?.(decision, subscriber);
                } catch (callbackError) {
                  aspect.logger.warn(`onStreamDeny callback failed: ${callbackError}`);
                }
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
