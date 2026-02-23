import { createDecorator } from '@toss/nestjs-aop';
import { EnforceTillDeniedOptions } from './StreamingEnforceOptions';

export const ENFORCE_TILL_DENIED_SYMBOL = Symbol('sapl:enforce-till-denied');

export const EnforceTillDenied = (options: EnforceTillDeniedOptions = {}) =>
  createDecorator(ENFORCE_TILL_DENIED_SYMBOL, options);
