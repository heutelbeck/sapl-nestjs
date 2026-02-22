import { SetMetadata } from '@nestjs/common';
import { EnforceOptions } from './EnforceOptions';

export const PRE_ENFORCE_KEY = 'sapl:pre-enforce';

/**
 * Metadata decorator that marks a route handler for SAPL pre-enforcement.
 *
 * This decorator only stores configuration metadata on the handler. The actual
 * authorization check is performed by PreEnforceInterceptor, which reads this
 * metadata, builds an authorization subscription, calls the PDP, and blocks
 * the request if the decision is not a clean PERMIT.
 *
 * Because the interceptor runs before the handler, the handler only executes
 * on PERMIT. Use this for handlers with side effects that should not execute
 * when access is denied.
 *
 * Example:
 *   @PreEnforce({ action: 'read', resource: 'exportData' })
 *   @Get('exportData/:id')
 *   async getExportData(@Param('id') id: string) { ... }
 */
export const PreEnforce = (options: EnforceOptions = {}) =>
  SetMetadata(PRE_ENFORCE_KEY, options);
