/**
 * The five PDP decision verbs, ordered for stable wire integer assignment.
 * Position in this list IS the proto enum value (INDETERMINATE = 0 is the
 * fail-closed default required by the protocol). Add new verbs at the
 * end only.
 */
export const DECISIONS = ['INDETERMINATE', 'PERMIT', 'DENY', 'NOT_APPLICABLE', 'SUSPEND'] as const;
export type Decision = (typeof DECISIONS)[number];

/** Set of valid decision strings, derived from `DECISIONS`. */
export const DECISION_SET: ReadonlySet<Decision> = new Set(DECISIONS);

/**
 * Proto enum integer -> Decision verb. Derived from `DECISIONS` index;
 * stays in lockstep with the proto schema as long as DECISIONS is not
 * reordered.
 */
export const DECISION_BY_INT: Readonly<Record<number, Decision>> = Object.fromEntries(
  DECISIONS.map((verb, index) => [index, verb]),
) as Readonly<Record<number, Decision>>;

/** Decision verb -> proto enum integer. Inverse of `DECISION_BY_INT`. */
export const INT_BY_DECISION: Readonly<Record<Decision, number>> = Object.fromEntries(
  DECISIONS.map((verb, index) => [verb, index]),
) as Readonly<Record<Decision, number>>;

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
