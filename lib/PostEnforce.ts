import { SetMetadata } from '@nestjs/common';
import { EnforceOptions } from './EnforceOptions';

export const POST_ENFORCE_KEY = 'sapl:post-enforce';

/**
 * Metadata decorator that marks a route handler for SAPL post-enforcement.
 *
 * This decorator only stores configuration metadata on the handler. The actual
 * authorization check is performed by PostEnforceInterceptor, which reads this
 * metadata, lets the handler execute first, then builds an authorization
 * subscription (including the handler's return value), calls the PDP, and
 * either returns the result or denies access.
 *
 * Important: The handler executes before authorization is checked. Any side
 * effects (database writes, emails, etc.) will occur regardless of the decision.
 * Use @PreEnforce for handlers with side effects that should not execute when
 * access is denied.
 *
 * Example:
 *   @PostEnforce({ action: 'read', resource: 'patientRecord' })
 *   @Get('patient/:id')
 *   async getPatient(@Param('id') id: string) { ... }
 */
export const PostEnforce = (options: EnforceOptions = {}) =>
  SetMetadata(POST_ENFORCE_KEY, options);
