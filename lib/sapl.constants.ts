export const SAPL_MODULE_OPTIONS = 'SAPL_MODULE_OPTIONS';

/** Path prefix for the SAPL Node HTTP PDP API. */
export const PDP_API_PREFIX = '/api/pdp/';

/**
 * Named endpoints exposed by the SAPL Node PDP. The HTTP transport
 * prefixes each with `PDP_API_PREFIX`; the RSocket transport uses the
 * bare route name as the composite-metadata route.
 */
export const PDP_ROUTE = {
  DECIDE_ONCE: 'decide-once',
  DECIDE: 'decide',
  MULTI_DECIDE: 'multi-decide',
  MULTI_DECIDE_ALL: 'multi-decide-all',
  MULTI_DECIDE_ALL_ONCE: 'multi-decide-all-once',
} as const;
