import { Logger } from '@nestjs/common';
import { Observable, Subscriber, Subscription, defaultIfEmpty } from 'rxjs';
import type { AuthorizationDecision } from '../types';
import {
  Emission,
  EnforcementPlan,
  Event,
  State,
  absentMaybe,
  cancelEvent,
  isTerminal,
  pdpDenyEvent,
  pdpErrorEvent,
  pdpPermitEvent,
  pdpSuspendEvent,
  pendingState,
  rapCompleteEvent,
  rapErrorEvent,
  rapItemEvent,
  step,
  suspendedReason,
} from './MealyMachine';
import { AccessGrantedSignal, AccessSuspendedSignal } from './BoundarySignals';

const FAILED_DENY_DECISION: AuthorizationDecision = { decision: 'DENY' };

const isPromise = <T>(value: T | Promise<T>): value is Promise<T> =>
  typeof value === 'object' && value !== null && typeof (value as Promise<T>).then === 'function';

export interface StreamingPipelineConfig {
  readonly pauseRapDuringSuspend: boolean;
  readonly decisions: Observable<AuthorizationDecision>;
  readonly planner: (decision: AuthorizationDecision) => EnforcementPlan;
  readonly rapSupplier: () => Observable<unknown>;
  readonly signalTransitions: boolean;
}

/**
 * Routes a single PDP decision into one FSM event under the strict
 * fail-closed discipline. Only `Decision.SUSPEND` produces `PdpSuspend`.
 * `PERMIT` with successful decision-scoped enforcement produces
 * `PdpPermit`; `PERMIT` with failed enforcement, `INDETERMINATE`,
 * `NOT_APPLICABLE`, and `DENY` all produce `PdpDeny` with an
 * operator-readable reason string.
 */
export function classify(
  decision: AuthorizationDecision,
  plan: EnforcementPlan,
  decisionScopedFailed: boolean,
): Event {
  switch (decision.decision) {
    case 'PERMIT':
      if (decisionScopedFailed) {
        return pdpDenyEvent(decision, plan, 'Decision-scoped obligation enforcement failed');
      }
      return pdpPermitEvent(decision, plan);
    case 'SUSPEND':
      return pdpSuspendEvent(decision, plan, suspendedReason(decision));
    case 'INDETERMINATE':
      return pdpDenyEvent(decision, plan, 'PDP returned indeterminate');
    case 'NOT_APPLICABLE':
      return pdpDenyEvent(decision, plan, 'No applicable policy');
    case 'DENY':
      return pdpDenyEvent(decision, plan, 'Access denied by policy');
  }
}

/**
 * Builds the cold streaming-PEP Observable. Each subscription gets a
 * fresh pipeline instance with its own FSM state, PDP subscription and
 * RAP subscription. Cancellation of the subscriber triggers a `Cancel`
 * event into the FSM and disposes both inner subscriptions.
 *
 * Output channel: real RAP values arrive on `next`; boundary signals
 * (when `signalTransitions` is true) arrive on `next` as instances of
 * `AccessSuspendedSignal` (suspend boundary) or `AccessGrantedSignal`
 * (grant or resume boundary). Terminal denials raise on the error
 * channel as `AccessDeniedError` (a NestJS `ForbiddenException`);
 * normal completion fires the complete channel.
 */
export function createStreamingPipeline(config: StreamingPipelineConfig): Observable<unknown> {
  return new Observable<unknown>((subscriber) => {
    const runner = new StreamingPipelineRunner(subscriber, config);
    runner.start();
    return () => runner.dispose();
  });
}

/**
 * RxJS is push-only; the demand-forwarding logic of the Reactor-based
 * reference implementation does not apply. A slow subscriber backs up
 * in its own buffers, not in the PEP.
 */
class StreamingPipelineRunner {
  private readonly logger = new Logger(StreamingPipelineRunner.name);
  private state: State = pendingState;
  private rapSubscription: Subscription | null = null;
  private pdpSubscription: Subscription | null = null;
  private terminated = false;

  constructor(
    private readonly subscriber: Subscriber<unknown>,
    private readonly config: StreamingPipelineConfig,
  ) {}

  start(): void {
    this.pdpSubscription = this.config.decisions.pipe(defaultIfEmpty(FAILED_DENY_DECISION)).subscribe({
      next: (decision) => this.handlePdpDecision(decision),
      error: (error: unknown) => this.handlePdpError(error),
    });
  }

  dispose(): void {
    if (this.terminated) {
      this.releaseInnerSubscriptions();
      return;
    }
    this.processEvent(cancelEvent);
  }

  private handlePdpDecision(decision: AuthorizationDecision): void {
    if (this.terminated) {
      return;
    }
    const plan = this.config.planner(decision);
    const decisionScopedFailed = plan.enforceDecisionConstraints(decision);
    this.processEvent(classify(decision, plan, decisionScopedFailed));
  }

  private handlePdpError(error: unknown): void {
    if (this.terminated) {
      return;
    }
    this.processEvent(pdpErrorEvent(error));
  }

  private handleRapValue(payload: unknown): void {
    if (this.terminated) {
      return;
    }
    const current = this.state;
    if (current.type !== 'Permitting') {
      // FSM totality: route the event so step() sees every input. The
      // user plan is bypassed because the FSM drops items in
      // non-Permitting states anyway, and executePerItem may have
      // side effects we do not want to run for items outside Permitting.
      this.processEvent(rapItemEvent(payload, { failureState: false, value: absentMaybe }));
      return;
    }
    // executePerItem may be sync or async. Dispatch the sync result
    // immediately so callers do not pay an extra microtask.
    const result = current.plan.executePerItem(payload);
    if (isPromise(result)) {
      result
        .then((enforcementResult) => {
          if (this.terminated) return;
          this.processEvent(rapItemEvent(payload, enforcementResult));
        })
        .catch((error: unknown) => {
          if (this.terminated) return;
          this.logger.warn(`executePerItem async failure: ${String(error)}`);
          this.processEvent(rapItemEvent(payload, { failureState: true, value: absentMaybe }));
        });
      return;
    }
    this.processEvent(rapItemEvent(payload, result));
  }

  private handleRapError(error: unknown): void {
    if (this.terminated) {
      return;
    }
    this.processEvent(rapErrorEvent(error));
  }

  private handleRapComplete(): void {
    if (this.terminated) {
      return;
    }
    this.processEvent(rapCompleteEvent);
  }

  private processEvent(event: Event): void {
    const priorState = this.state;
    const transition = step(this.state, event);
    this.state = transition.newState;
    for (const emission of transition.emissions) {
      this.renderEmission(emission);
    }
    if (isTerminal(transition)) {
      this.terminated = true;
      this.releaseInnerSubscriptions();
      return;
    }
    this.manageRapSubscription(priorState, this.state);
    if (this.state.type === 'Permitting') {
      this.ensureRapSubscribed();
    }
  }

  private manageRapSubscription(priorState: State, nextState: State): void {
    if (!this.config.pauseRapDuringSuspend) {
      return;
    }
    if (nextState.type === 'Suspended' && priorState.type !== 'Suspended') {
      this.disposeRap();
    }
  }

  private ensureRapSubscribed(): void {
    if (this.rapSubscription !== null || this.terminated) {
      return;
    }
    this.rapSubscription = this.config.rapSupplier().subscribe({
      next: (value) => this.handleRapValue(value),
      error: (error: unknown) => this.handleRapError(error),
      complete: () => this.handleRapComplete(),
    });
  }

  private disposeRap(): void {
    if (this.rapSubscription === null) {
      return;
    }
    const subscription = this.rapSubscription;
    this.rapSubscription = null;
    subscription.unsubscribe();
  }

  private releaseInnerSubscriptions(): void {
    this.disposeRap();
    if (this.pdpSubscription !== null) {
      const subscription = this.pdpSubscription;
      this.pdpSubscription = null;
      subscription.unsubscribe();
    }
  }

  private renderEmission(emission: Emission): void {
    switch (emission.type) {
      case 'Emit':
        this.emit((subscriber) => subscriber.next(emission.value));
        return;
      case 'EmitError':
        this.emit((subscriber) => subscriber.error(emission.error));
        return;
      case 'EmitComplete':
        this.emit((subscriber) => subscriber.complete());
        return;
      case 'EmitTransition':
        this.renderTransition(emission);
        return;
    }
  }

  private renderTransition(emission: Extract<Emission, { type: 'EmitTransition' }>): void {
    if (!this.config.signalTransitions) {
      return;
    }
    const signal =
      emission.reason.type === 'Granted'
        ? new AccessGrantedSignal(emission.reason.decision)
        : new AccessSuspendedSignal();
    this.emit((subscriber) => subscriber.next(signal));
  }

  /**
   * Guarded emission helper. The subscriber may have been unsubscribed
   * externally between the FSM step and our delivery, in which case
   * `subscriber.closed` is true; calling next / error / complete on a
   * closed subscriber throws ObjectUnsubscribedError in older RxJS or
   * routes to the global error hook in newer RxJS. Either is noise.
   */
  private emit(action: (subscriber: Subscriber<unknown>) => void): void {
    if (!this.subscriber.closed) {
      action(this.subscriber);
    }
  }
}
