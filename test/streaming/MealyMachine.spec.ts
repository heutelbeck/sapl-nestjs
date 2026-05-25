import type { AuthorizationDecision } from '../../lib/types';
import { AccessDeniedError } from '../../lib/streaming/BoundarySignals';
import {
  Emission,
  EnforcementPlan,
  EnforcementResult,
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
  permittingState,
  presentMaybe,
  rapCompleteEvent,
  rapErrorEvent,
  rapItemEvent,
  step,
  suspendedReason,
  suspendedState,
  terminatedState,
} from '../../lib/streaming/MealyMachine';

const PERMIT_DECISION: AuthorizationDecision = { decision: 'PERMIT' };
const SUSPEND_DECISION: AuthorizationDecision = { decision: 'SUSPEND' };
const DENY_DECISION: AuthorizationDecision = { decision: 'DENY' };
const PLAN: EnforcementPlan = {
  enforceDecisionConstraints: () => false,
  executePerItem: () => ({ failureState: false, value: absentMaybe }),
};

const presentResult = (value: unknown): EnforcementResult<unknown> => ({
  failureState: false,
  value: presentMaybe(value),
});

const absentResult = (): EnforcementResult<unknown> => ({
  failureState: false,
  value: absentMaybe,
});

const failedResult = (): EnforcementResult<unknown> => ({
  failureState: true,
  value: absentMaybe,
});

const permittingFixture = (): State => permittingState(PLAN);

const pdpPermitFixture = (): Event => pdpPermitEvent(PERMIT_DECISION, PLAN);

const pdpSuspendFixture = (): Event =>
  pdpSuspendEvent(SUSPEND_DECISION, PLAN, suspendedReason(SUSPEND_DECISION));

const pdpDenyFixture = (): Event => pdpDenyEvent(DENY_DECISION, PLAN, 'Access denied by policy');

const expectSingleEmissionOfType = <K extends Emission['type']>(
  emissions: readonly Emission[],
  expectedType: K,
): Extract<Emission, { type: K }> => {
  expect(emissions).toHaveLength(1);
  const emission = emissions[0];
  expect(emission.type).toBe(expectedType);
  return emission as Extract<Emission, { type: K }>;
};

describe('MealyMachine', () => {
  describe('Routing matrix: source state x event -> next state + emissions', () => {
    describe('from Pending', () => {
      test('whenPdpPermitThenTransitionsToPermittingAndEmitsGrantedBoundary', () => {
        const result = step(pendingState, pdpPermitFixture());

        expect(result.newState.type).toBe('Permitting');
        const transition = expectSingleEmissionOfType(result.emissions, 'EmitTransition');
        expect(transition.reason.type).toBe('Granted');
      });

      test('whenPdpSuspendThenTransitionsToSuspendedAndEmitsTransition', () => {
        const event = pdpSuspendFixture();
        const result = step(pendingState, event);

        expect(result.newState.type).toBe('Suspended');
        const transition = expectSingleEmissionOfType(result.emissions, 'EmitTransition');
        if (event.type !== 'PdpSuspend') throw new Error('fixture invariant violated');
        expect(transition.reason).toBe(event.reason);
      });

      test('whenPdpDenyThenTransitionsToTerminatedAndEmitsAccessDeniedError', () => {
        const result = step(pendingState, pdpDenyFixture());

        expect(result.newState.type).toBe('Terminated');
        const emission = expectSingleEmissionOfType(result.emissions, 'EmitError');
        expect(emission.error).toBeInstanceOf(AccessDeniedError);
      });

      test.each([
        ['Present', presentResult('v')],
        ['Absent', absentResult()],
        ['Failed', failedResult()],
      ])('whenRapItemWith%sOutcomeThenDropsAndStaysInPending', (_label, enforcementResult) => {
        const result = step(pendingState, rapItemEvent('payload', enforcementResult));

        expect(result.newState.type).toBe('Pending');
        expect(result.emissions).toHaveLength(0);
      });

      test('whenRapCompleteThenTransitionsToTerminatedAndEmitsComplete', () => {
        const result = step(pendingState, rapCompleteEvent);

        expect(result.newState.type).toBe('Terminated');
        expectSingleEmissionOfType(result.emissions, 'EmitComplete');
      });

      test('whenRapErrorThenTransitionsToTerminatedAndForwardsThrowable', () => {
        const error = new Error('rap boom');
        const result = step(pendingState, rapErrorEvent(error));

        expect(result.newState.type).toBe('Terminated');
        const emission = expectSingleEmissionOfType(result.emissions, 'EmitError');
        expect(emission.error).toBe(error);
      });

      test('whenPdpErrorThenTransitionsToTerminatedAndForwardsThrowable', () => {
        const error = new Error('pdp boom');
        const result = step(pendingState, pdpErrorEvent(error));

        expect(result.newState.type).toBe('Terminated');
        const emission = expectSingleEmissionOfType(result.emissions, 'EmitError');
        expect(emission.error).toBe(error);
      });

      test('whenCancelThenTransitionsToTerminatedSilently', () => {
        const result = step(pendingState, cancelEvent);

        expect(result.newState.type).toBe('Terminated');
        expect(result.emissions).toHaveLength(0);
      });
    });

    describe('from Permitting', () => {
      test('whenPdpPermitThenReplansSilentlyAndStaysInPermitting', () => {
        const result = step(permittingFixture(), pdpPermitFixture());

        expect(result.newState.type).toBe('Permitting');
        expect(result.emissions).toHaveLength(0);
      });

      test('whenPermitFollowedByRapItemFailedThenTerminates', () => {
        const afterPermit = step(pendingState, pdpPermitFixture());
        const afterItem = step(afterPermit.newState, rapItemEvent('bad', failedResult()));

        expect(afterItem.newState.type).toBe('Terminated');
        const emission = expectSingleEmissionOfType(afterItem.emissions, 'EmitError');
        expect(emission.error).toBeInstanceOf(AccessDeniedError);
      });

      test('whenPdpSuspendThenCrossesBoundaryToSuspended', () => {
        const event = pdpSuspendFixture();
        const result = step(permittingFixture(), event);

        expect(result.newState.type).toBe('Suspended');
        const transition = expectSingleEmissionOfType(result.emissions, 'EmitTransition');
        if (event.type !== 'PdpSuspend') throw new Error('fixture invariant violated');
        expect(transition.reason).toBe(event.reason);
      });

      test('whenPdpDenyThenTransitionsToTerminatedAndEmitsAccessDeniedError', () => {
        const result = step(permittingFixture(), pdpDenyFixture());

        expect(result.newState.type).toBe('Terminated');
        expectSingleEmissionOfType(result.emissions, 'EmitError');
      });

      test('whenRapItemPresentThenEmitsValueAndStaysInPermitting', () => {
        const result = step(permittingFixture(), rapItemEvent('payload-1', presentResult('post-mapper-1')));

        expect(result.newState.type).toBe('Permitting');
        const emission = expectSingleEmissionOfType(result.emissions, 'Emit');
        expect(emission.value).toBe('post-mapper-1');
      });

      test('whenRapItemAbsentThenDropsSilentlyAndStaysInPermitting', () => {
        const result = step(permittingFixture(), rapItemEvent('payload-2', absentResult()));

        expect(result.newState.type).toBe('Permitting');
        expect(result.emissions).toHaveLength(0);
      });

      test('whenRapItemFailedThenTransitionsToTerminatedAndEmitsAccessDeniedError', () => {
        const result = step(permittingFixture(), rapItemEvent('bad-payload', failedResult()));

        expect(result.newState.type).toBe('Terminated');
        const emission = expectSingleEmissionOfType(result.emissions, 'EmitError');
        expect(emission.error).toBeInstanceOf(AccessDeniedError);
      });

      test('whenRapCompleteThenTransitionsToTerminatedAndEmitsComplete', () => {
        const result = step(permittingFixture(), rapCompleteEvent);

        expect(result.newState.type).toBe('Terminated');
        expectSingleEmissionOfType(result.emissions, 'EmitComplete');
      });

      test('whenRapErrorThenTransitionsToTerminatedAndForwardsThrowable', () => {
        const error = new Error('rap boom');
        const result = step(permittingFixture(), rapErrorEvent(error));

        expect(result.newState.type).toBe('Terminated');
        const emission = expectSingleEmissionOfType(result.emissions, 'EmitError');
        expect(emission.error).toBe(error);
      });

      test('whenPdpErrorThenTransitionsToTerminatedAndForwardsThrowable', () => {
        const error = new Error('pdp boom');
        const result = step(permittingFixture(), pdpErrorEvent(error));

        expect(result.newState.type).toBe('Terminated');
        const emission = expectSingleEmissionOfType(result.emissions, 'EmitError');
        expect(emission.error).toBe(error);
      });

      test('whenCancelThenTransitionsToTerminatedSilently', () => {
        const result = step(permittingFixture(), cancelEvent);

        expect(result.newState.type).toBe('Terminated');
        expect(result.emissions).toHaveLength(0);
      });
    });

    describe('from Suspended', () => {
      test('whenPdpPermitThenResumesToPermittingAndEmitsGrantedBoundary', () => {
        const result = step(suspendedState, pdpPermitFixture());

        expect(result.newState.type).toBe('Permitting');
        const transition = expectSingleEmissionOfType(result.emissions, 'EmitTransition');
        expect(transition.reason.type).toBe('Granted');
      });

      test('whenPdpSuspendThenReSuspendsSilently', () => {
        const result = step(suspendedState, pdpSuspendFixture());

        expect(result.newState.type).toBe('Suspended');
        expect(result.emissions).toHaveLength(0);
      });

      test('whenPdpDenyThenTransitionsToTerminatedAndEmitsAccessDeniedError', () => {
        const result = step(suspendedState, pdpDenyFixture());

        expect(result.newState.type).toBe('Terminated');
        expectSingleEmissionOfType(result.emissions, 'EmitError');
      });

      test.each([
        ['Present', presentResult('v')],
        ['Absent', absentResult()],
        ['Failed', failedResult()],
      ])('whenRapItemWith%sOutcomeThenDropsAndStaysInSuspended', (_label, enforcementResult) => {
        const result = step(suspendedState, rapItemEvent('payload', enforcementResult));

        expect(result.newState.type).toBe('Suspended');
        expect(result.emissions).toHaveLength(0);
      });

      test('whenRapCompleteThenTransitionsToTerminatedAndEmitsComplete', () => {
        const result = step(suspendedState, rapCompleteEvent);

        expect(result.newState.type).toBe('Terminated');
        expectSingleEmissionOfType(result.emissions, 'EmitComplete');
      });

      test('whenRapErrorThenTransitionsToTerminatedAndForwardsThrowable', () => {
        const error = new Error('rap boom');
        const result = step(suspendedState, rapErrorEvent(error));

        expect(result.newState.type).toBe('Terminated');
        const emission = expectSingleEmissionOfType(result.emissions, 'EmitError');
        expect(emission.error).toBe(error);
      });

      test('whenPdpErrorThenTransitionsToTerminatedAndForwardsThrowable', () => {
        const error = new Error('pdp boom');
        const result = step(suspendedState, pdpErrorEvent(error));

        expect(result.newState.type).toBe('Terminated');
        const emission = expectSingleEmissionOfType(result.emissions, 'EmitError');
        expect(emission.error).toBe(error);
      });

      test('whenCancelThenTransitionsToTerminatedSilently', () => {
        const result = step(suspendedState, cancelEvent);

        expect(result.newState.type).toBe('Terminated');
        expect(result.emissions).toHaveLength(0);
      });
    });

    describe('from Terminated (absorbing)', () => {
      const everyEvent: ReadonlyArray<[string, Event]> = [
        ['PdpPermit', pdpPermitFixture()],
        ['PdpSuspend', pdpSuspendFixture()],
        ['PdpDeny', pdpDenyFixture()],
        ['PdpError', pdpErrorEvent(new Error('e'))],
        ['RapItem-present', rapItemEvent('p', presentResult('v'))],
        ['RapItem-absent', rapItemEvent('p', absentResult())],
        ['RapItem-failed', rapItemEvent('p', failedResult())],
        ['RapError', rapErrorEvent(new Error('e'))],
        ['RapComplete', rapCompleteEvent],
        ['Cancel', cancelEvent],
      ];

      test.each(everyEvent)('whenEvent%sThenStaysTerminatedAndEmitsNothing', (_label, event) => {
        const result = step(terminatedState, event);

        expect(result.newState.type).toBe('Terminated');
        expect(result.emissions).toHaveLength(0);
      });
    });
  });

  describe('Properties: invariants over states and events', () => {
    const nonTerminatedStates: ReadonlyArray<[string, State]> = [
      ['Pending', pendingState],
      ['Permitting', permittingFixture()],
      ['Suspended', suspendedState],
    ];

    test.each(nonTerminatedStates)('whenPdpDenyFrom%sThenAlwaysReachesTerminated', (_label, source) => {
      const result = step(source, pdpDenyFixture());

      expect(result.newState.type).toBe('Terminated');
      expectSingleEmissionOfType(result.emissions, 'EmitError');
    });

    test.each(nonTerminatedStates)('whenPdpPermitFrom%sThenAlwaysReachesPermitting', (_label, source) => {
      const result = step(source, pdpPermitFixture());

      expect(result.newState.type).toBe('Permitting');
    });

    test.each(nonTerminatedStates)('whenPdpSuspendFrom%sThenAlwaysReachesSuspended', (_label, source) => {
      const result = step(source, pdpSuspendFixture());

      expect(result.newState.type).toBe('Suspended');
    });

    test.each<[string, Event]>([
      ['Cancel', cancelEvent],
      ['RapComplete', rapCompleteEvent],
      ['RapError', rapErrorEvent(new Error('e'))],
      ['PdpError', pdpErrorEvent(new Error('e'))],
    ])('whenLifecycleTerminator%sFromAnyNonTerminatedStateThenAlwaysReachesTerminated', (_label, event) => {
      for (const source of [pendingState, permittingFixture(), suspendedState]) {
        const result = step(source, event);
        expect(result.newState.type).toBe('Terminated');
      }
    });

    test.each([
      ['Present', presentResult('v')],
      ['Absent', absentResult()],
      ['Failed', failedResult()],
    ])('whenRapItemWith%sInPendingThenNoEmitLeak', (_label, enforcementResult) => {
      const result = step(pendingState, rapItemEvent('p', enforcementResult));

      expect(result.emissions.filter((e) => e.type === 'Emit')).toHaveLength(0);
    });

    test.each([
      ['Present', presentResult('v')],
      ['Absent', absentResult()],
      ['Failed', failedResult()],
    ])('whenRapItemWith%sInSuspendedThenNoEmitLeak', (_label, enforcementResult) => {
      const result = step(suspendedState, rapItemEvent('p', enforcementResult));

      expect(result.emissions.filter((e) => e.type === 'Emit')).toHaveLength(0);
    });

    test('whenSequenceCrossesBoundariesThenEmitTransitionCountEqualsTrueCrossingCount', () => {
      const sequence: Event[] = [
        pdpPermitFixture(),
        pdpPermitFixture(),
        pdpSuspendFixture(),
        pdpSuspendFixture(),
        pdpPermitFixture(),
        pdpDenyFixture(),
      ];

      let crossings = 0;
      let boundaryEmissions = 0;
      let state: State = pendingState;
      let previous: State = state;
      for (const event of sequence) {
        const result = step(state, event);
        state = result.newState;
        if (isBoundaryCrossing(previous, state)) {
          crossings += 1;
        }
        boundaryEmissions += result.emissions.filter((e) => e.type === 'EmitTransition').length;
        previous = state;
      }

      expect(boundaryEmissions).toBe(crossings);
    });

    test('whenAnyTerminatorEventThenEmitsAtMostOneTerminalEmission', () => {
      const terminators: Event[] = [
        cancelEvent,
        rapCompleteEvent,
        rapErrorEvent(new Error('e')),
        pdpErrorEvent(new Error('e')),
        pdpDenyFixture(),
      ];

      for (const terminator of terminators) {
        const result = step(pendingState, terminator);
        const terminalEmissions = result.emissions.filter(
          (e) => e.type === 'EmitComplete' || e.type === 'EmitError',
        );
        expect(terminalEmissions.length).toBeLessThanOrEqual(1);
      }
    });

    test('whenRapItemFailedInNonPermittingStateThenAlwaysDropsSilently', () => {
      const failed = rapItemEvent('p', failedResult());

      expect(step(pendingState, failed).emissions).toHaveLength(0);
      expect(step(suspendedState, failed).emissions).toHaveLength(0);
    });

    test('whenStepLandsInTerminatedThenIsTerminalReturnsTrue', () => {
      const result = step(pendingState, pdpDenyFixture());

      expect(isTerminal(result)).toBe(true);
    });

    test('whenStepLandsInPermittingThenIsTerminalReturnsFalse', () => {
      const result = step(pendingState, pdpPermitFixture());

      expect(isTerminal(result)).toBe(false);
    });
  });
});

function isBoundaryCrossing(from: State, to: State): boolean {
  if (from.type === 'Pending' && to.type === 'Permitting') return true;
  if (from.type === 'Pending' && to.type === 'Suspended') return true;
  if (from.type === 'Permitting' && to.type === 'Suspended') return true;
  if (from.type === 'Suspended' && to.type === 'Permitting') return true;
  return false;
}
