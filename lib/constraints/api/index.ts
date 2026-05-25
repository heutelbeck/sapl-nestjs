import type { SignalKind } from '../Signal';

export type HandlerShape = 'runner' | 'consumer' | 'mapper';

/**
 * A constraint handler scoped to a signal at a priority. Runners are
 * admissible at any signal; mappers and consumers only at data-carrying
 * signals (input, output, error). The handler's shape determines what
 * it does with the value passed to it:
 *
 * - Runner:   `() => void`        side effect only
 * - Consumer: `(value) => void`   observes the value, does not transform
 * - Mapper:   `(value) => value`  transforms the value (obligation-only)
 */
export interface ScopedHandler {
  readonly signal: SignalKind;
  readonly priority: number;
  readonly shape: HandlerShape;
  readonly handler: (value: unknown) => unknown | void;
}

/**
 * Per paper Algorithm 1 (lines 468-480): a handler provider claims
 * responsibility for some subset of constraints. For a recognised
 * constraint, returns the set of scoped handlers that together enforce
 * it (possibly targeting multiple signals). For an unrecognised
 * constraint, returns the empty array.
 */
export interface ConstraintHandlerProvider {
  getHandlers(constraint: unknown): ReadonlyArray<ScopedHandler>;
}
