import { ExecutionContext } from '@nestjs/common';
import { SubscriptionContext } from './SubscriptionContext';
import { EnforceOptions, SubscriptionField } from './EnforceOptions';

/**
 * Resolve a SubscriptionField: if it's a function, call it with the context.
 * Otherwise return it as a literal value.
 */
function resolve(field: SubscriptionField | undefined, ctx: SubscriptionContext): any {
  return typeof field === 'function' ? field(ctx) : field;
}

/**
 * Build the SubscriptionContext from a NestJS ExecutionContext.
 */
export function buildContext(executionContext: ExecutionContext): SubscriptionContext {
  const request = executionContext.switchToHttp().getRequest();
  return {
    request,
    params: request.params ?? {},
    query: request.query ?? {},
    body: request.body,
    handler: executionContext.getHandler().name,
    controller: executionContext.getClass().name,
  };
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
 * Build the default environment: harvest available request metadata.
 * Only includes values already present on the request -- never generates
 * synthetic values like timestamps or request IDs.
 */
function defaultEnvironment(ctx: SubscriptionContext): any {
  const env: Record<string, any> = {
    ip: ctx.request.ip,
    hostname: ctx.request.hostname,
  };

  const headers = ctx.request.headers;
  if (headers['date'])               env.timestamp = headers['date'];
  if (headers['x-request-id'])       env.requestId = headers['x-request-id'];
  if (headers['x-correlation-id'])   env.correlationId = headers['x-correlation-id'];
  if (headers['x-forwarded-for'])    env.forwardedFor = headers['x-forwarded-for'];

  return env;
}

/**
 * Build a complete SAPL authorization subscription from EnforceOptions and
 * the current NestJS ExecutionContext.
 *
 * For each field: if the user provided a value (literal or callback), use it.
 * Otherwise apply the sensible default.
 */
export function buildSubscription(
  options: EnforceOptions,
  executionContext: ExecutionContext,
): Record<string, any> {
  const ctx = buildContext(executionContext);

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

/**
 * Build a complete SAPL authorization subscription from EnforceOptions and
 * a pre-built SubscriptionContext. Used by PostEnforceInterceptor where the
 * context includes returnValue set after handler execution.
 */
export function buildSubscriptionFromContext(
  options: EnforceOptions,
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
