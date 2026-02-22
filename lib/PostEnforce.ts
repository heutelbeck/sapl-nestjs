import { createDecorator } from '@toss/nestjs-aop';
import { EnforceOptions } from './EnforceOptions';

export const POST_ENFORCE_SYMBOL = Symbol('sapl:post-enforce');

/**
 * Decorator that marks a method for SAPL post-enforcement.
 *
 * Works on any injectable class method (controllers, services, etc.) via
 * AOP aspects. The actual authorization check is performed by
 * PostEnforceAspect, which lets the method execute first, then builds an
 * authorization subscription (including the method's return value), calls
 * the PDP, and either returns the result or denies access.
 *
 * Important: The method executes before authorization is checked. Any side
 * effects (database writes, emails, etc.) will occur regardless of the decision.
 * Use @PreEnforce for methods with side effects that should not execute when
 * access is denied.
 *
 * Example:
 *   @PostEnforce({ action: 'read', resource: 'patientRecord' })
 *   @Get('patient/:id')
 *   async getPatient(@Param('id') id: string) { ... }
 */
export const PostEnforce = (options: EnforceOptions = {}) =>
  createDecorator(POST_ENFORCE_SYMBOL, options);
