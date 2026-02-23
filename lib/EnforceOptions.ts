import { SubscriptionContext } from './SubscriptionContext';
import { AuthorizationDecision } from './types';

/**
 * A subscription field value: either a literal (sent as-is to the PDP) or a
 * callback that receives the request-time SubscriptionContext and returns
 * the value dynamically.
 *
 * Examples:
 *   action: 'read'                                       // literal
 *   resource: (ctx) => ({ id: ctx.params.id })            // callback
 *   subject: (ctx) => ctx.request.user                    // callback
 */
export type SubscriptionField<T = any> = T | ((ctx: SubscriptionContext) => T);

/**
 * Callback invoked when the PDP denies access. Receives the request-time context
 * and the PDP decision. The return value becomes the HTTP response body (with 200).
 * If not provided, a ForbiddenException (403) is thrown.
 */
export type OnDenyHandler = (ctx: SubscriptionContext, decision: AuthorizationDecision) => any;

/**
 * The five SAPL authorization subscription fields.
 * All fields are optional -- sensible defaults are derived at runtime.
 */
export interface SubscriptionOptions {
  subject?: SubscriptionField;
  action?: SubscriptionField;
  resource?: SubscriptionField;
  environment?: SubscriptionField;
  secrets?: SubscriptionField;
}

/**
 * Options for @PreEnforce and @PostEnforce decorators.
 * Extends SubscriptionOptions with a deny handler callback.
 */
export interface EnforceOptions extends SubscriptionOptions {
  onDeny?: OnDenyHandler;
}
