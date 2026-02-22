import { createDecorator } from '@toss/nestjs-aop';
import { EnforceOptions } from './EnforceOptions';

export const PRE_ENFORCE_SYMBOL = Symbol('sapl:pre-enforce');

/**
 * Decorator that marks a method for SAPL pre-enforcement.
 *
 * Works on any injectable class method (controllers, services, etc.) via
 * AOP aspects. The actual authorization check is performed by
 * PreEnforceAspect, which builds an authorization subscription, calls
 * the PDP, and blocks the invocation if the decision is not PERMIT.
 *
 * Because the aspect runs before the method, the method only executes
 * on PERMIT. Use this for methods with side effects that should not
 * execute when access is denied.
 *
 * Example:
 *   @PreEnforce({ action: 'read', resource: 'exportData' })
 *   @Get('exportData/:id')
 *   async getExportData(@Param('id') id: string) { ... }
 */
export const PreEnforce = (options: EnforceOptions = {}) =>
  createDecorator(PRE_ENFORCE_SYMBOL, options);
