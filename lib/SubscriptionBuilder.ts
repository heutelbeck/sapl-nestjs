import { ClsService, CLS_REQ } from 'nestjs-cls';
import { SubscriptionContext } from './SubscriptionContext';
import { SubscriptionOptions, SubscriptionField } from './SubscriptionOptions';
import { AuthorizationSubscription } from './types';

/**
 * Resolve a SubscriptionField: if it's a function, call it with the context.
 * Otherwise return it as a literal value.
 */
function resolve(field: SubscriptionField | undefined, context: SubscriptionContext): any {
  return typeof field === 'function' ? field(context) : field;
}

/**
 * Build the default subject: the decoded JWT claims from request.user,
 * falling back to "anonymous" if no auth guard populated it.
 */
function defaultSubject(context: SubscriptionContext): any {
  return context.request.user ?? 'anonymous';
}

/**
 * Build the default action: HTTP method + controller/handler coordinates.
 */
function defaultAction(context: SubscriptionContext): any {
  return {
    method: context.request.method,
    controller: context.controller,
    handler: context.handler,
  };
}

/**
 * Build the default resource: route path pattern + resolved parameters.
 */
function defaultResource(context: SubscriptionContext): any {
  return {
    path: context.request.route?.path ?? context.request.url,
    params: context.params,
  };
}

/**
 * Build the default environment: server-side request metadata only.
 * Client-controlled headers (Date, X-Forwarded-For, X-Request-Id,
 * X-Correlation-Id) are deliberately excluded because they can be forged.
 * Use the environment callback in SubscriptionOptions to include them explicitly
 * if needed.
 */
function defaultEnvironment(context: SubscriptionContext): any {
  return {
    ip: context.request.ip,
    hostname: context.request.hostname,
  };
}

/**
 * Build a SubscriptionContext from the current CLS request and method metadata.
 */
export function buildContext(
  cls: ClsService,
  methodName: string,
  className: string,
  args: any[],
): SubscriptionContext {
  const request = cls.get(CLS_REQ) ?? {};
  return {
    request,
    params: request.params ?? {},
    query: request.query ?? {},
    body: request.body,
    handler: methodName,
    controller: className,
    args,
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
  context: SubscriptionContext,
): AuthorizationSubscription {
  const subject = options.subject !== undefined ? resolve(options.subject, context) : defaultSubject(context);
  const action = options.action !== undefined ? resolve(options.action, context) : defaultAction(context);
  const resource =
    options.resource !== undefined ? resolve(options.resource, context) : defaultResource(context);
  const environment =
    options.environment !== undefined ? resolve(options.environment, context) : defaultEnvironment(context);
  const secrets = options.secrets !== undefined ? resolve(options.secrets, context) : undefined;

  const subscription: AuthorizationSubscription = { subject, action, resource, environment };
  if (secrets !== undefined) {
    subscription.secrets = secrets;
  }
  return subscription;
}
