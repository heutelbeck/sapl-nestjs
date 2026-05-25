import { SubscriptionContext } from './SubscriptionContext';

/**
 * A subscription field value: either a literal (sent as-is to the PDP) or a
 * callback that receives the request-time SubscriptionContext and returns
 * the value dynamically.
 *
 * Examples:
 *   action: 'read'                                       // literal
 *   resource: (context) => ({ id: context.params.id })            // callback
 *   subject: (context) => context.request.user                    // callback
 */
export type SubscriptionField<T = any> = T | ((context: SubscriptionContext) => T);

/**
 * The five SAPL authorization subscription fields.
 * All fields are optional -- sensible defaults are derived at runtime.
 *
 * Denial response shaping is done via NestJS exception filters
 * (`@Catch(ForbiddenException)`), not via a per-decorator callback.
 * Exception filters integrate correctly with `@Transactional`; a
 * per-decorator deny-return would silently commit transactions when
 * a post-method obligation fails.
 */
export interface SubscriptionOptions {
  subject?: SubscriptionField;
  action?: SubscriptionField;
  resource?: SubscriptionField;
  environment?: SubscriptionField;
  secrets?: SubscriptionField;
}
