import { Logger } from '@nestjs/common';
import { Aspect, LazyDecorator, WrapParams } from '@toss/nestjs-aop';
import { ClsService, CLS_REQ } from 'nestjs-cls';
import { Observable, Subscription } from 'rxjs';
import { ENFORCE_RECOVERABLE_SYMBOL } from './EnforceRecoverableIfDenied';
import { EnforceRecoverableOptions } from './StreamingEnforceOptions';
import { PdpService } from './pdp.service';
import { SubscriptionContext } from './SubscriptionContext';
import { buildSubscriptionFromContext } from './SubscriptionBuilder';
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
      const source$ = method(...args);

      return new Observable((subscriber) => {
        let currentBundle: StreamingConstraintHandlerBundle | null = null;
        let sourceSubscription: Subscription | null = null;
        let permitted = false;
        let wasPermitted = false;
        let isFirstDecision = true;

        const ctx = aspect.buildContext(methodName, className, args);
        const subscription = buildSubscriptionFromContext(metadata, ctx);
        const decisions$ = aspect.pdpService.decide(subscription);

        const decisionSub = decisions$.subscribe({
          next: (decision) => {
            if (decision.decision === 'PERMIT') {
              try {
                currentBundle = aspect.constraintService.streamingBundleFor(decision);
                currentBundle.handleOnDecisionConstraints();
              } catch (error) {
                aspect.logger.warn(`Obligation handling failed: ${error}`);
                permitted = false;
                currentBundle = null;
                if (wasPermitted || isFirstDecision) {
                  wasPermitted = false;
                  metadata.onStreamDeny?.(decision, subscriber);
                }
                isFirstDecision = false;
                return;
              }
              permitted = true;

              if (!wasPermitted) {
                wasPermitted = true;
                if (!isFirstDecision) {
                  metadata.onStreamRecover?.(decision, subscriber);
                }
              }

              if (!sourceSubscription) {
                sourceSubscription = source$.subscribe({
                  next: (value) => {
                    if (!permitted || !currentBundle) return;
                    try {
                      const transformed = currentBundle.handleAllOnNextConstraints(value);
                      subscriber.next(transformed);
                    } catch (error) {
                      aspect.logger.warn(`Constraint handling failed on next: ${error}`);
                    }
                  },
                  error: (err) => subscriber.error(err),
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

              if (wasPermitted || isFirstDecision) {
                wasPermitted = false;
                metadata.onStreamDeny?.(decision, subscriber);
              }
            }
            isFirstDecision = false;
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
