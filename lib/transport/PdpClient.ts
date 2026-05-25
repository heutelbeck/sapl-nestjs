import { Observable } from 'rxjs';
import type {
  AuthorizationDecision,
  AuthorizationSubscription,
  IdentifiableAuthorizationDecision,
  MultiAuthorizationDecision,
  MultiAuthorizationSubscription,
} from '../types';

/**
 * The transport-independent surface every PDP client implements. Both
 * HTTP and RSocket implementations conform to this contract; the
 * higher-level `PdpService` delegates to the configured client without
 * caring about wire protocol or codec choice.
 *
 * Implementations are expected to be fail-closed: when the PDP is
 * unreachable, the codec rejects a payload, or auth setup fails, the
 * stream surfaces `INDETERMINATE` (for streaming) or returns a fresh
 * `INDETERMINATE` (for one-shot) rather than crashing the consumer.
 */
export interface PdpClient {
  /**
   * Single one-shot authorization request. Returns the PDP's decision
   * or `INDETERMINATE` on transport / parse failure.
   */
  decideOnce(subscription: AuthorizationSubscription): Promise<AuthorizationDecision>;

  /**
   * Subscribe to a continuous PDP stream for one authorization
   * subscription. The PDP emits a new decision whenever its evaluation
   * changes. Consecutive duplicates are suppressed by the PDP. The
   * stream reconnects on transport failure and emits `INDETERMINATE`
   * across the gap.
   */
  decide(subscription: AuthorizationSubscription): Observable<AuthorizationDecision>;

  /**
   * Multi-subscription stream where decisions arrive individually,
   * each tagged with its subscription id.
   */
  multiDecide(subscriptions: MultiAuthorizationSubscription): Observable<IdentifiableAuthorizationDecision>;

  /**
   * Multi-subscription stream where each emission is a complete
   * snapshot of every subscription's current decision.
   */
  multiDecideAll(subscriptions: MultiAuthorizationSubscription): Observable<MultiAuthorizationDecision>;

  /**
   * Single one-shot multi-subscription request. Returns the snapshot
   * once all subscriptions have decisions.
   */
  multiDecideAllOnce(subscriptions: MultiAuthorizationSubscription): Promise<MultiAuthorizationDecision>;

  /**
   * Release any persistent resources (connection pools, RSocket
   * sockets, token refresh timers). Idempotent.
   */
  close(): Promise<void>;
}
