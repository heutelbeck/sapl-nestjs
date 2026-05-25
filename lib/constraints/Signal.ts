import type { AuthorizationDecision } from '../types';

/**
 * Discriminated union of the lifecycle events at which constraint
 * handlers may attach. Eight kinds: four value-carrying
 * (decision, input, output, error) and four void (subscribe, cancel,
 * complete, termination).
 *
 * The vocabulary deliberately excludes signals the local framework
 * cannot fire: no SubscriptionSignal-with-demand-count (RxJS is
 * push-only), no AfterTerminationSignal (no RxJS analogue), no HTTP /
 * SQL / Mongo signals (no PEP fires them in this port).
 */
export type Signal =
  | { readonly kind: 'decision'; readonly value: AuthorizationDecision }
  | { readonly kind: 'input'; readonly value: readonly unknown[] }
  | { readonly kind: 'output'; readonly value: unknown }
  | { readonly kind: 'error'; readonly value: Error }
  | { readonly kind: 'subscribe' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'complete' }
  | { readonly kind: 'termination' };

export type SignalKind = Signal['kind'];

/**
 * The decision signal is self-contained: only Runners are admissible.
 * Mappers and Consumers attach only to data-carrying signals.
 */
const DATA_CARRYING_SIGNALS: ReadonlySet<SignalKind> = new Set(['input', 'output', 'error']);
export const isDataCarryingSignal = (signal: SignalKind): boolean => DATA_CARRYING_SIGNALS.has(signal);
