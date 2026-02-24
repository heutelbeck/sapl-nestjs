/**
 * Minimal structural type for the HTTP request. Covers properties used by
 * the library's default subscription builders. Compatible with both Express
 * and Fastify request objects.
 */
export interface SaplRequest {
  user?: unknown;
  method?: string;
  url?: string;
  ip?: string;
  hostname?: string;
  route?: { path?: string };
  params?: Record<string, string>;
  query?: Record<string, string | string[]>;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}

/**
 * Context available to subscription field callbacks at request time.
 *
 * Passed to any EnforceOptions field that is a function, allowing dynamic
 * subscription construction based on the current request.
 *
 * Example:
 *   @PreEnforce({ resource: (ctx) => ({ pilotId: ctx.params.pilotId }) })
 */
export interface SubscriptionContext {
  /** The full HTTP request object (has .user, .headers, .cookies, etc.) */
  request: SaplRequest;
  /** Route parameters -- @Get(':pilotId') -> ctx.params.pilotId */
  params: Record<string, string>;
  /** Query string parameters -- ?page=2 -> ctx.query.page */
  query: Record<string, string | string[]>;
  /** Request body (POST/PUT) */
  body: any;
  /** Handler method name on the controller */
  handler: string;
  /** Controller class name */
  controller: string;
  /** Handler return value (only populated in @PostEnforce context) */
  returnValue?: any;
  /** Method arguments (available for service methods outside HTTP context) */
  args?: any[];
}
