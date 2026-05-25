import type { AuthorizationDecision } from '../types';
import { AccessDeniedError } from './BoundarySignals';

export { AccessDeniedError, AccessSuspendedSignal, AccessGrantedSignal } from './BoundarySignals';

/**
 * Discriminated union mirroring the Java `Maybe` carried by per-item
 * enforcement results. `Present` wraps a post-mapper value; `Absent`
 * means the mapper signalled drop-this-item without an error.
 */
export type Maybe<T> = { readonly type: 'Present'; readonly value: T } | { readonly type: 'Absent' };

export const presentMaybe = <T>(value: T): Maybe<T> => Object.freeze({ type: 'Present', value });
export const absentMaybe: Maybe<never> = Object.freeze({ type: 'Absent' });

/**
 * The per-decision plan the streaming pipeline carries alongside
 * `Permitting` state and the three PDP decision events. The FSM does
 * not invoke any method on the plan; it threads the reference through
 * so the surrounding adapter can run decision-scoped enforcement
 * (around grant) and per-item enforcement (around each RAP value).
 */
export interface EnforcementPlan {
  /**
   * Run decision-scoped enforcement for an incoming `Decision.PERMIT`.
   * Returns true when enforcement could not be honoured, in which case
   * the pipeline reclassifies the PERMIT as `PdpDeny` with kind
   * `PERMIT_NOT_ENFORCEABLE`. Idempotent for any single decision.
   */
  enforceDecisionConstraints(decision: AuthorizationDecision): boolean;

  /**
   * Per-item enforcement. Called for every RAP value while the FSM is
   * in `Permitting`. `failureState=true` terminates; a `Present` value
   * is emitted; an `Absent` value is dropped silently.
   *
   * Returning a Promise is supported when the handler requires I/O.
   * Per-item ordering on a single RAP stream is preserved.
   */
  executePerItem(payload: unknown): EnforcementResult<unknown> | Promise<EnforcementResult<unknown>>;
}

/**
 * Per-item enforcement outcome consumed by `RapItem` events. `failureState`
 * routes to terminal denial; `value` routes to either emit or drop.
 */
export interface EnforcementResult<T> {
  readonly failureState: boolean;
  readonly value: Maybe<T>;
}

/**
 * Why the machine crossed a state boundary. Carried by `EmitTransition`
 * so subscribers (when `signalTransitions` is on) can react and used
 * internally to format diagnostic text.
 */
export type TransitionReason =
  | { readonly type: 'Granted'; readonly decision: AuthorizationDecision }
  | { readonly type: 'Suspended'; readonly decision: AuthorizationDecision };

export const grantedReason = (decision: AuthorizationDecision): TransitionReason =>
  Object.freeze({ type: 'Granted', decision });

export const suspendedReason = (decision: AuthorizationDecision): TransitionReason =>
  Object.freeze({ type: 'Suspended', decision });

/**
 * The state set. `Pending`, `Suspended`, `Terminated` are payload-free
 * singletons; `Permitting` carries the active plan.
 */
export type State =
  | { readonly type: 'Pending' }
  | { readonly type: 'Permitting'; readonly plan: EnforcementPlan }
  | { readonly type: 'Suspended' }
  | { readonly type: 'Terminated' };

export const pendingState: State = Object.freeze({ type: 'Pending' });
export const suspendedState: State = Object.freeze({ type: 'Suspended' });
export const terminatedState: State = Object.freeze({ type: 'Terminated' });

export const permittingState = (plan: EnforcementPlan): State => Object.freeze({ type: 'Permitting', plan });

/**
 * The input alphabet. Eight cases covering PDP-side decisions, RAP-side
 * stream events, and downstream subscriber lifecycle.
 */
export type Event =
  | {
      readonly type: 'PdpPermit';
      readonly decision: AuthorizationDecision;
      readonly plan: EnforcementPlan;
    }
  | {
      readonly type: 'PdpSuspend';
      readonly decision: AuthorizationDecision;
      readonly plan: EnforcementPlan;
      readonly reason: TransitionReason;
    }
  | {
      readonly type: 'PdpDeny';
      readonly decision: AuthorizationDecision;
      readonly plan: EnforcementPlan;
      readonly reason: string;
    }
  | { readonly type: 'PdpError'; readonly error: unknown }
  | {
      readonly type: 'RapItem';
      readonly payload: unknown;
      readonly enforcementResult: EnforcementResult<unknown>;
    }
  | { readonly type: 'RapError'; readonly error: unknown }
  | { readonly type: 'RapComplete' }
  | { readonly type: 'Cancel' };

export const pdpPermitEvent = (decision: AuthorizationDecision, plan: EnforcementPlan): Event =>
  Object.freeze({ type: 'PdpPermit', decision, plan });

export const pdpSuspendEvent = (
  decision: AuthorizationDecision,
  plan: EnforcementPlan,
  reason: TransitionReason,
): Event => Object.freeze({ type: 'PdpSuspend', decision, plan, reason });

export const pdpDenyEvent = (decision: AuthorizationDecision, plan: EnforcementPlan, reason: string): Event =>
  Object.freeze({ type: 'PdpDeny', decision, plan, reason });

export const pdpErrorEvent = (error: unknown): Event => Object.freeze({ type: 'PdpError', error });

export const rapItemEvent = (payload: unknown, enforcementResult: EnforcementResult<unknown>): Event =>
  Object.freeze({ type: 'RapItem', payload, enforcementResult });

export const rapErrorEvent = (error: unknown): Event => Object.freeze({ type: 'RapError', error });

export const rapCompleteEvent: Event = Object.freeze({ type: 'RapComplete' });
export const cancelEvent: Event = Object.freeze({ type: 'Cancel' });

/**
 * The output alphabet. The step function returns a list of zero or
 * more emissions; the Reactor (here, RxJS) adapter delivers them in
 * order before processing the next event.
 */
export type Emission =
  | { readonly type: 'Emit'; readonly value: unknown }
  | { readonly type: 'EmitError'; readonly error: unknown }
  | { readonly type: 'EmitComplete' }
  | { readonly type: 'EmitTransition'; readonly reason: TransitionReason };

export const emitValue = (value: unknown): Emission => Object.freeze({ type: 'Emit', value });
export const emitError = (error: unknown): Emission => Object.freeze({ type: 'EmitError', error });
export const emitCompleteEmission: Emission = Object.freeze({ type: 'EmitComplete' });
export const emitTransition = (reason: TransitionReason): Emission =>
  Object.freeze({ type: 'EmitTransition', reason });

/**
 * The codomain of `step`. Pairs the post-step `State` with the ordered
 * emission sequence the adapter must deliver before the next event.
 */
export interface Step {
  readonly newState: State;
  readonly emissions: readonly Emission[];
}

const stepTo = (newState: State, ...emissions: Emission[]): Step =>
  Object.freeze({ newState, emissions: Object.freeze(emissions) });

/**
 * Returns true when the step lands in the absorbing `Terminated` state.
 * The adapter stops dispatching events after observing a terminal step.
 */
export const isTerminal = (step: Step): boolean => step.newState.type === 'Terminated';

/**
 * Pure step function. Total, deterministic, no side effects, no RxJS
 * or NestJS dependencies. The combined transition + output relation of
 * the Mealy machine.
 */
export function step(state: State, event: Event): Step {
  if (state.type === 'Terminated') {
    return stepTo(state);
  }
  switch (event.type) {
    case 'Cancel':
      return stepTo(terminatedState);
    case 'RapComplete':
      return stepTo(terminatedState, emitCompleteEmission);
    case 'RapError':
      return stepTo(terminatedState, emitError(event.error));
    case 'PdpError':
      return stepTo(terminatedState, emitError(event.error));
    case 'PdpDeny':
      return handleDeny(event.reason);
    case 'PdpPermit':
      return handlePermit(state, event.decision, event.plan);
    case 'PdpSuspend':
      return handleSuspend(state, event.reason);
    case 'RapItem':
      return handleItem(state, event.enforcementResult);
  }
}

function handlePermit(state: State, decision: AuthorizationDecision, plan: EnforcementPlan): Step {
  const next = permittingState(plan);
  if (state.type === 'Permitting') {
    return stepTo(next);
  }
  return stepTo(next, emitTransition(grantedReason(decision)));
}

function handleSuspend(state: State, reason: TransitionReason): Step {
  if (state.type === 'Suspended') {
    return stepTo(suspendedState);
  }
  return stepTo(suspendedState, emitTransition(reason));
}

function handleDeny(reason: string): Step {
  return stepTo(terminatedState, emitError(new AccessDeniedError(reason)));
}

function handleItem(state: State, enforcementResult: EnforcementResult<unknown>): Step {
  switch (state.type) {
    case 'Pending':
    case 'Suspended':
    case 'Terminated':
      return stepTo(state);
    case 'Permitting':
      return permittingItem(state, enforcementResult);
  }
}

function permittingItem(
  state: Extract<State, { type: 'Permitting' }>,
  enforcementResult: EnforcementResult<unknown>,
): Step {
  if (enforcementResult.failureState) {
    return stepTo(terminatedState, emitError(new AccessDeniedError('Per-item obligation failure')));
  }
  if (enforcementResult.value.type === 'Present') {
    return stepTo(state, emitValue(enforcementResult.value.value));
  }
  return stepTo(state);
}
