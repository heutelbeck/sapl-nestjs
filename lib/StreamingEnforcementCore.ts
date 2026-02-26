import { ForbiddenException, Logger } from '@nestjs/common';
import { Observable, Subscription } from 'rxjs';
import { AuthorizationDecision } from './types';
import { OnStreamDenyHandler, OnStreamRecoverHandler, RestrictedStreamEventEmitter } from './StreamingEnforceOptions';
import { ConstraintEnforcementService } from './constraints/ConstraintEnforcementService';
import { StreamingConstraintHandlerBundle } from './constraints/StreamingConstraintHandlerBundle';

export interface StreamingEnforcementConfig {
  terminalOnDeny: boolean;
  onStreamDeny?: OnStreamDenyHandler;
  onStreamRecover?: OnStreamRecoverHandler;
}

export function createStreamingEnforcement<T>(
  method: Function,
  args: any[],
  decisions$: Observable<AuthorizationDecision>,
  constraintService: ConstraintEnforcementService,
  config: StreamingEnforcementConfig,
  logger: Logger,
): Observable<T> {
  return new Observable<T>((subscriber) => {
    let currentBundle: StreamingConstraintHandlerBundle | null = null;
    let sourceSubscription: Subscription | null = null;
    let accessState: 'initial' | 'permitted' | 'denied' = 'initial';
    let terminated = false;

    const restrictedEmitter: RestrictedStreamEventEmitter = {
      next: (v: any) => { if (!terminated) subscriber.next(v); },
    };

    const decisionSub = decisions$.subscribe({
      next: (decision) => {
        if (terminated) return;
        const previousState = accessState;

        if (decision.decision === 'PERMIT') {
          try {
            const newBundle = constraintService.streamingBundleFor(decision);
            newBundle.handleOnDecisionConstraints();
            currentBundle = newBundle;
          } catch (error) {
            logger.warn(`Obligation handling failed: ${error}`);
            accessState = 'denied';
            currentBundle = null;
            if (previousState !== 'denied') {
              invokeOnStreamDeny(config.onStreamDeny, decision, restrictedEmitter, logger);
            }
            if (config.terminalOnDeny && !terminated) {
              terminated = true;
              subscriber.error(new ForbiddenException('Access denied by policy'));
            }
            return;
          }
          accessState = 'permitted';

          if (previousState === 'denied') {
            invokeOnStreamRecover(config.onStreamRecover, decision, restrictedEmitter, logger);
          }

          if (!sourceSubscription) {
            sourceSubscription = method(...args).subscribe({
              next: (value: any) => {
                if (terminated || accessState !== 'permitted' || !currentBundle) return;
                try {
                  const transformed = currentBundle.handleAllOnNextConstraints(value);
                  subscriber.next(transformed);
                } catch (error) {
                  logger.warn(`Constraint handling failed on next: ${error}`);
                  if (config.terminalOnDeny) {
                    if (!terminated) {
                      terminated = true;
                      subscriber.error(new ForbiddenException('Constraint handling failed'));
                    }
                  } else if (config.onStreamDeny) {
                    accessState = 'denied';
                    currentBundle = null;
                    invokeOnStreamDeny(config.onStreamDeny, decision, restrictedEmitter, logger);
                  } else {
                    accessState = 'denied';
                    currentBundle = null;
                  }
                }
              },
              error: (err: any) => { if (!terminated) subscriber.error(err); },
              complete: () => {
                if (terminated) return;
                currentBundle?.handleOnCompleteConstraints();
                subscriber.complete();
              },
            });
          }
        } else {
          accessState = 'denied';
          currentBundle = null;
          try {
            const bestEffort = constraintService.streamingBestEffortBundleFor(decision);
            bestEffort.handleOnDecisionConstraints();
          } catch {
            /* best effort */
          }

          if (config.terminalOnDeny || previousState !== 'denied') {
            invokeOnStreamDeny(config.onStreamDeny, decision, restrictedEmitter, logger);
          }

          if (config.terminalOnDeny && !terminated) {
            terminated = true;
            subscriber.error(new ForbiddenException('Access denied by policy'));
          }
        }
      },
      error: (err) => { if (!terminated) subscriber.error(err); },
    });

    return () => {
      currentBundle?.handleOnCancelConstraints();
      decisionSub.unsubscribe();
      sourceSubscription?.unsubscribe();
    };
  });
}

function invokeOnStreamDeny(
  handler: OnStreamDenyHandler | undefined,
  decision: AuthorizationDecision,
  emitter: RestrictedStreamEventEmitter,
  logger: Logger,
): void {
  if (!handler) return;
  try {
    handler(decision, emitter);
  } catch (callbackError) {
    logger.warn(`onStreamDeny callback failed: ${callbackError}`);
  }
}

function invokeOnStreamRecover(
  handler: OnStreamRecoverHandler | undefined,
  decision: AuthorizationDecision,
  emitter: RestrictedStreamEventEmitter,
  logger: Logger,
): void {
  if (!handler) return;
  try {
    handler(decision, emitter);
  } catch (callbackError) {
    logger.warn(`onStreamRecover callback failed: ${callbackError}`);
  }
}
