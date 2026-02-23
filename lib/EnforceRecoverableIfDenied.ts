import { createDecorator } from '@toss/nestjs-aop';
import { EnforceRecoverableOptions } from './StreamingEnforceOptions';

export const ENFORCE_RECOVERABLE_SYMBOL = Symbol('sapl:enforce-recoverable-if-denied');

export const EnforceRecoverableIfDenied = (options: EnforceRecoverableOptions = {}) =>
  createDecorator(ENFORCE_RECOVERABLE_SYMBOL, options);
