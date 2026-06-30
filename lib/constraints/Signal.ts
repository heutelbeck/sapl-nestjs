import type { AuthorizationDecision } from '../types';

/**
 * Discriminated union of the lifecycle events at which constraint
 * handlers may attach. Four core lifecycle value-carrying kinds
 * (decision, input, output, error), four void (subscribe, cancel,
 * complete, termination), and two data-layer query-manipulation kinds
 * (mongo_query, sql_query) that data-layer shims fire at the cut point.
 *
 * The vocabulary deliberately excludes signals the local framework
 * cannot fire: no SubscriptionSignal-with-demand-count (RxJS is
 * push-only) and no AfterTerminationSignal (no RxJS analogue).
 *
 * The query-manipulation kinds are not raised by any aspect directly;
 * a shim (Mongoose plugin, Prisma extension) discharges them at query
 * time against the request-scoped active plan. They are admitted to a
 * plan only when a shim has registered them via the shim-signal
 * registry.
 */
export type Signal =
  | { readonly kind: 'decision'; readonly value: AuthorizationDecision }
  | { readonly kind: 'input'; readonly value: readonly unknown[] }
  | { readonly kind: 'output'; readonly value?: unknown }
  | { readonly kind: 'error'; readonly value: Error }
  | { readonly kind: 'subscribe' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'complete' }
  | { readonly kind: 'termination' }
  | { readonly kind: 'mongo_query'; readonly value: unknown }
  | { readonly kind: 'sql_query'; readonly value: unknown };

export type SignalKind = Signal['kind'];

/**
 * The decision signal is self-contained: only Runners are admissible.
 * Mappers and Consumers attach only to data-carrying signals. The
 * query-manipulation kinds carry the query value a mapper rewrites.
 */
const DATA_CARRYING_SIGNALS: ReadonlySet<SignalKind> = new Set([
  'input',
  'output',
  'error',
  'mongo_query',
  'sql_query',
]);
export const isDataCarryingSignal = (signal: SignalKind): boolean => DATA_CARRYING_SIGNALS.has(signal);
