import { SubscriptionContext } from './SubscriptionContext';
import { SubscriptionOptions, SubscriptionField } from './EnforceOptions';

/**
 * Resolve a SubscriptionField: if it's a function, call it with the context.
 * Otherwise return it as a literal value.
 */
function resolve(field: SubscriptionField | undefined, ctx: SubscriptionContext): any {
  return typeof field === 'function' ? field(ctx) : field;
}

/**
 * Build the default subject: the decoded JWT claims from request.user,
 * falling back to "anonymous" if no auth guard populated it.
 */
function defaultSubject(ctx: SubscriptionContext): any {
  return ctx.request.user ?? 'anonymous';
}

/**
 * Build the default action: HTTP method + controller/handler coordinates.
 */
function defaultAction(ctx: SubscriptionContext): any {
  return {
    method: ctx.request.method,
    controller: ctx.controller,
    handler: ctx.handler,
  };
}

/**
 * Build the default resource: route path pattern + resolved parameters.
 */
function defaultResource(ctx: SubscriptionContext): any {
  return {
    path: ctx.request.route?.path ?? ctx.request.url,
    params: ctx.params,
  };
}

/**
 * Build the default environment: server-side request metadata only.
 * Client-controlled headers (Date, X-Forwarded-For, X-Request-Id,
 * X-Correlation-Id) are deliberately excluded because they can be forged.
 * Use the environment callback in EnforceOptions to include them explicitly
 * if needed.
 */
function defaultEnvironment(ctx: SubscriptionContext): any {
  return {
    ip: ctx.request.ip,
    hostname: ctx.request.hostname,
  };
}

/**
 * Build a complete SAPL authorization subscription from SubscriptionOptions
 * and a pre-built SubscriptionContext.
 *
 * For each field: if the user provided a value (literal or callback), use it.
 * Otherwise apply the sensible default.
 */
export function buildSubscriptionFromContext(
  options: SubscriptionOptions,
  ctx: SubscriptionContext,
): Record<string, any> {
  const subject     = options.subject     !== undefined ? resolve(options.subject, ctx)     : defaultSubject(ctx);
  const action      = options.action      !== undefined ? resolve(options.action, ctx)      : defaultAction(ctx);
  const resource    = options.resource    !== undefined ? resolve(options.resource, ctx)    : defaultResource(ctx);
  const environment = options.environment !== undefined ? resolve(options.environment, ctx) : defaultEnvironment(ctx);
  const secrets     = options.secrets     !== undefined ? resolve(options.secrets, ctx)     : undefined;

  const subscription: Record<string, any> = { subject, action, resource, environment };
  if (secrets !== undefined) {
    subscription.secrets = secrets;
  }
  return subscription;
}
