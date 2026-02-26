export type Decision = 'PERMIT' | 'DENY' | 'INDETERMINATE' | 'NOT_APPLICABLE';

/**
 * A PDP authorization decision with optional constraints.
 *
 * The `decision` field contains the access control verdict.
 * `obligations` must be handled (unhandled obligations deny access).
 * `advice` should be handled but failures are non-fatal.
 * `resource` replaces the handler's return value when present.
 */
export interface AuthorizationDecision {
  decision: Decision;
  obligations?: unknown[];
  advice?: unknown[];
  resource?: unknown;
}

/**
 * An authorization subscription sent to the PDP.
 *
 * All fields are optional at the type level because sensible defaults
 * are derived at runtime from the HTTP request context.
 */
export interface AuthorizationSubscription {
  subject?: unknown;
  action?: unknown;
  resource?: unknown;
  environment?: unknown;
  secrets?: unknown;
}

/**
 * Multiple authorization subscriptions keyed by client-chosen IDs.
 * Sent to the PDP multi-subscription endpoints for batch authorization.
 */
export interface MultiAuthorizationSubscription {
  subscriptions: Record<string, AuthorizationSubscription>;
}

/**
 * A single authorization decision tagged with its subscription ID.
 * Returned by the multi-decide endpoint where decisions arrive individually.
 */
export interface IdentifiableAuthorizationDecision {
  subscriptionId: string;
  decision: AuthorizationDecision;
}

/**
 * A complete snapshot of all subscription decisions.
 * Returned by the multi-decide-all endpoint. Emitted whenever any
 * individual decision changes, always containing all current decisions.
 */
export interface MultiAuthorizationDecision {
  decisions: Record<string, AuthorizationDecision>;
}
