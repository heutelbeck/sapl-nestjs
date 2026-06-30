import type { AuthorizationDecision } from '../../lib/types';
import {
  absentMaybe,
  cancelEvent,
  type Emission,
  type EnforcementPlan,
  type EnforcementResult,
  type Event,
  pdpDenyEvent,
  pdpErrorEvent,
  pdpPermitEvent,
  pdpSuspendEvent,
  pendingState,
  permittingState,
  presentMaybe,
  rapCompleteEvent,
  rapErrorEvent,
  rapItemEvent,
  type State,
  suspendedReason,
  suspendedState,
  terminatedState,
} from '../../lib/streaming/MealyMachine';

/**
 * Shared fixtures, subset providers, and translation helpers for the
 * MealyMachine test suites. Used by:
 *
 * - `MealyMachine.cell.spec.ts` — content checks of one row of δ.
 * - `MealyMachine.invariant.spec.ts` — Lean theorems witnessed at the
 *   test layer (per-cell and sequence).
 */

export const PERMIT_DECISION: AuthorizationDecision = { decision: 'PERMIT' };
export const SUSPEND_DECISION: AuthorizationDecision = { decision: 'SUSPEND' };
export const DENY_DECISION: AuthorizationDecision = { decision: 'DENY' };

export const PLAN: EnforcementPlan = {
  enforceDecisionConstraints: () => false,
  executePerItem: () => ({ failureState: false, value: absentMaybe }),
};

export const EMIT_VALUE = 'EMIT_VALUE';
export const EMIT_ERROR = 'EMIT_ERROR';
export const EMIT_COMPLETE = 'EMIT_COMPLETE';
export const EMIT_TRANSITION_GRANTED = 'EMIT_TRANSITION_GRANTED';
export const EMIT_TRANSITION_SUSPENDED = 'EMIT_TRANSITION_SUSPENDED';

export const resultPresent = (value: unknown): EnforcementResult<unknown> => ({
  failureState: false,
  value: presentMaybe(value),
});

export const resultAbsent = (): EnforcementResult<unknown> => ({
  failureState: false,
  value: absentMaybe,
});

export const resultFailed = (): EnforcementResult<unknown> => ({
  failureState: true,
  value: absentMaybe,
});

export const permitting = (): State => permittingState(PLAN);

export const pdpPermit = (): Event => pdpPermitEvent(PERMIT_DECISION, PLAN);

export const pdpSuspend = (): Event =>
  pdpSuspendEvent(SUSPEND_DECISION, PLAN, suspendedReason(SUSPEND_DECISION));

export const pdpDeny = (): Event => pdpDenyEvent(DENY_DECISION, PLAN, 'Access denied by policy');

export const pdpError = (): Event => pdpErrorEvent(new Error('pdp boom'));

export const rapItemPresent = (): Event => rapItemEvent('payload', resultPresent('post-mapper'));

export const rapItemAbsent = (): Event => rapItemEvent('payload', resultAbsent());

export const rapItemFailed = (): Event => rapItemEvent('payload', resultFailed());

export const rapError = (): Event => rapErrorEvent(new Error('rap boom'));

export const stateByName = (name: string): State => {
  switch (name) {
    case 'Pending':
      return pendingState;
    case 'Permitting':
      return permitting();
    case 'Suspended':
      return suspendedState;
    case 'Terminated':
      return terminatedState;
    default:
      throw new Error(`Unknown state: ${name}`);
  }
};

export const eventByName = (name: string, outcome: string): Event => {
  switch (name) {
    case 'PdpPermit':
      return pdpPermit();
    case 'PdpSuspend':
      return pdpSuspend();
    case 'PdpDeny':
      return pdpDeny();
    case 'PdpError':
      return pdpError();
    case 'RapError':
      return rapError();
    case 'RapComplete':
      return rapCompleteEvent;
    case 'Cancel':
      return cancelEvent;
    case 'RapItem':
      return rapItemByOutcome(outcome);
    default:
      throw new Error(`Unknown event: ${name}`);
  }
};

export const emissionKind = (emission: Emission): string => {
  switch (emission.type) {
    case 'Emit':
      return EMIT_VALUE;
    case 'EmitError':
      return EMIT_ERROR;
    case 'EmitComplete':
      return EMIT_COMPLETE;
    case 'EmitTransition':
      return emission.reason.type === 'Granted' ? EMIT_TRANSITION_GRANTED : EMIT_TRANSITION_SUSPENDED;
  }
};

// ---- Subset providers (consumed via test.each) ----

export const nonTerminatedStates: ReadonlyArray<[string, State]> = [
  ['Pending', pendingState],
  ['Permitting', permitting()],
  ['Suspended', suspendedState],
];

export const allEvents: ReadonlyArray<[string, Event]> = [
  ['PdpPermit', pdpPermit()],
  ['PdpSuspend', pdpSuspend()],
  ['PdpDeny', pdpDeny()],
  ['PdpError', pdpError()],
  ['RapItem-Present', rapItemPresent()],
  ['RapItem-Absent', rapItemAbsent()],
  ['RapItem-Failed', rapItemFailed()],
  ['RapError', rapError()],
  ['RapComplete', rapCompleteEvent],
  ['Cancel', cancelEvent],
];

export const lifecycleTerminators: ReadonlyArray<[string, Event]> = [
  ['Cancel', cancelEvent],
  ['RapComplete', rapCompleteEvent],
  ['RapError', rapError()],
  ['PdpError', pdpError()],
];

export const itemOutcomes: ReadonlyArray<[string, Event]> = [
  ['Present', rapItemPresent()],
  ['Absent', rapItemAbsent()],
  ['Failed', rapItemFailed()],
];

export const nonTerminatedStateAndLifecycleTerminator: ReadonlyArray<[string, string, State, Event]> =
  nonTerminatedStates.flatMap(([sName, source]) =>
    lifecycleTerminators.map(([eName, event]): [string, string, State, Event] => [
      sName,
      eName,
      source,
      event,
    ]),
  );

const rapItemByOutcome = (outcome: string): Event => {
  switch (outcome) {
    case 'Present':
      return rapItemPresent();
    case 'Absent':
      return rapItemAbsent();
    case 'Failed':
      return rapItemFailed();
    default:
      throw new Error(`Unknown RapItem outcome: ${outcome}`);
  }
};
