import { step } from '../../lib/streaming/MealyMachine';
import {
  allEvents,
  itemOutcomes,
  nonTerminatedStates,
  nonTerminatedStateAndLifecycleTerminator,
  pdpDeny,
  pdpPermit,
  pdpSuspend,
  permitting,
  rapItemFailed,
} from './MealyTestSupport';
import {
  pendingState,
  suspendedState,
  terminatedState,
  type State,
  type Event,
} from '../../lib/streaming/MealyMachine';

/**
 * Layer-2 invariants on `step(state, event)`.
 *
 * Each test is the executable witness of a theorem proved on the formal
 * model in `stream-pep-lean/StreamPepFsm/Properties.lean`. Test names
 * mirror the Lean theorem names verbatim (snake_case). The block
 * comment carries the Lean statement; the test body discharges it by
 * computation, by enumeration over a finite quantification domain, or
 * by replaying a fixed event sequence — whichever shape Lean uses.
 *
 * The Lean module groups its theorems by section (per-cell invariants
 * first, sequence invariants last); the test ordering follows the same
 * order.
 */

describe('MealyMachine invariants', () => {
  /*
   * Lean theorem: terminated_is_absorbing
   *
   *   ∀ (e : Event), step .Terminated e = ⟨.Terminated, []⟩
   */
  test.each(allEvents)('terminated_is_absorbing [%s]', (_name, event: Event) => {
    const result = step(terminatedState, event);

    expect(result.newState.type).toBe('Terminated');
    expect(result.emissions).toHaveLength(0);
  });

  /*
   * Lean theorem: deny_universally_terminates
   *
   *   ∀ (s : State), s ≠ .Terminated →
   *     step s .PdpDeny = ⟨.Terminated, [.EmitError]⟩
   */
  test.each(nonTerminatedStates)('deny_universally_terminates [from %s]', (_name, source: State) => {
    const result = step(source, pdpDeny());

    expect(result.newState.type).toBe('Terminated');
    expect(result.emissions).toHaveLength(1);
    expect(result.emissions[0].type).toBe('EmitError');
  });

  /*
   * Lean theorem: permit_universally_reaches_permitting
   *
   *   ∀ (s : State), s ≠ .Terminated →
   *     (step s .PdpPermit).newState = .Permitting
   */
  test.each(nonTerminatedStates)('permit_universally_reaches_permitting [from %s]', (_name, source: State) => {
    const result = step(source, pdpPermit());

    expect(result.newState.type).toBe('Permitting');
  });

  /*
   * Lean theorem: suspend_universally_reaches_suspended
   *
   *   ∀ (s : State), s ≠ .Terminated →
   *     (step s .PdpSuspend).newState = .Suspended
   */
  test.each(nonTerminatedStates)('suspend_universally_reaches_suspended [from %s]', (_name, source: State) => {
    const result = step(source, pdpSuspend());

    expect(result.newState.type).toBe('Suspended');
  });

  /*
   * Lean theorem: lifecycle_terminators_reach_terminated
   *
   *   ∀ (s : State) (e : Event),
   *     s ≠ .Terminated →
   *     e = .Cancel ∨ e = .RapComplete ∨ e = .RapError ∨ e = .PdpError →
   *     (step s e).newState = .Terminated
   */
  test.each(nonTerminatedStateAndLifecycleTerminator)(
    'lifecycle_terminators_reach_terminated [from %s, event %s]',
    (_sName, _eName, source: State, event: Event) => {
      const result = step(source, event);

      expect(result.newState.type).toBe('Terminated');
    },
  );

  /*
   * Lean theorem: no_emit_in_suspended
   *
   *   ∀ (o : ItemOutcome),
   *     .Emit ∉ (step .Suspended (.RapItem o)).emissions
   */
  test.each(itemOutcomes)('no_emit_in_suspended [outcome %s]', (_outcome, event: Event) => {
    const result = step(suspendedState, event);

    expect(result.emissions.filter((e) => e.type === 'Emit')).toHaveLength(0);
  });

  /*
   * Lean theorem: no_emit_in_pending
   *
   *   ∀ (o : ItemOutcome),
   *     .Emit ∉ (step .Pending (.RapItem o)).emissions
   */
  test.each(itemOutcomes)('no_emit_in_pending [outcome %s]', (_outcome, event: Event) => {
    const result = step(pendingState, event);

    expect(result.emissions.filter((e) => e.type === 'Emit')).toHaveLength(0);
  });

  /*
   * Lean theorem: item_failure_universally_terminates
   *
   *   ∀ (s : State), s ≠ .Terminated →
   *     step s (.RapItem .Failed) = ⟨.Terminated, [.EmitError]⟩
   *
   * Strict-fail-closed reading of paper Invariant 5 ("Universal
   * fulfillment-failure termination"): a per-item obligation failure
   * terminates regardless of source state.
   */
  test.each(nonTerminatedStates)('item_failure_universally_terminates [from %s]', (_name, source: State) => {
    const result = step(source, rapItemFailed());

    expect(result.newState.type).toBe('Terminated');
    expect(result.emissions).toHaveLength(1);
    expect(result.emissions[0].type).toBe('EmitError');
  });

  /*
   * Lean theorem: replan_is_silent
   *
   *   (step .Permitting .PdpPermit).emissions = []
   */
  test('replan_is_silent', () => {
    const result = step(permitting(), pdpPermit());

    expect(result.emissions).toHaveLength(0);
  });

  /*
   * Lean theorem: re_suspend_is_silent
   *
   *   (step .Suspended .PdpSuspend).emissions = []
   */
  test('re_suspend_is_silent', () => {
    const result = step(suspendedState, pdpSuspend());

    expect(result.emissions).toHaveLength(0);
  });

  /*
   * Lean theorem: initial_permit_emits_boundary
   *
   *   (step .Pending .PdpPermit).emissions = [.EmitTransition]
   */
  test('initial_permit_emits_boundary', () => {
    const result = step(pendingState, pdpPermit());

    expect(result.emissions).toHaveLength(1);
    expect(result.emissions[0].type).toBe('EmitTransition');
    if (result.emissions[0].type === 'EmitTransition') {
      expect(result.emissions[0].reason.type).toBe('Granted');
    }
  });

  /*
   * Lean theorem: resume_permit_emits_boundary
   *
   *   (step .Suspended .PdpPermit).emissions = [.EmitTransition]
   */
  test('resume_permit_emits_boundary', () => {
    const result = step(suspendedState, pdpPermit());

    expect(result.emissions).toHaveLength(1);
    expect(result.emissions[0].type).toBe('EmitTransition');
    if (result.emissions[0].type === 'EmitTransition') {
      expect(result.emissions[0].reason.type).toBe('Granted');
    }
  });

  /*
   * Lean theorem: pending_to_suspended_emits_boundary
   *
   *   (step .Pending .PdpSuspend).emissions = [.EmitTransition]
   */
  test('pending_to_suspended_emits_boundary', () => {
    const result = step(pendingState, pdpSuspend());

    expect(result.emissions).toHaveLength(1);
    expect(result.emissions[0].type).toBe('EmitTransition');
  });

  /*
   * Lean theorem: permitting_to_suspended_emits_boundary
   *
   *   (step .Permitting .PdpSuspend).emissions = [.EmitTransition]
   */
  test('permitting_to_suspended_emits_boundary', () => {
    const result = step(permitting(), pdpSuspend());

    expect(result.emissions).toHaveLength(1);
    expect(result.emissions[0].type).toBe('EmitTransition');
  });

  /*
   * Lean theorem: permit_then_failed_item_terminates
   *
   *   (replay .Pending [.PdpPermit, .RapItem .Failed]).fst = .Terminated
   */
  test('permit_then_failed_item_terminates', () => {
    const afterPermit = step(pendingState, pdpPermit());
    const afterItem = step(afterPermit.newState, rapItemFailed());

    expect(afterItem.newState.type).toBe('Terminated');
  });
});
