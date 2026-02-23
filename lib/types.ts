/**
 * A PDP authorization decision with optional constraints.
 *
 * The `decision` field contains the access control verdict.
 * `obligations` must be handled (unhandled obligations deny access).
 * `advice` should be handled but failures are non-fatal.
 * `resource` replaces the handler's return value when present.
 */
export interface AuthorizationDecision {
  decision: string;
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
