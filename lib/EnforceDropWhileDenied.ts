import { createDecorator } from '@toss/nestjs-aop';
import { EnforceDropWhileDeniedOptions } from './StreamingEnforceOptions';

export const ENFORCE_DROP_WHILE_DENIED_SYMBOL = Symbol('sapl:enforce-drop-while-denied');

export const EnforceDropWhileDenied = (options: EnforceDropWhileDeniedOptions = {}) =>
  createDecorator(ENFORCE_DROP_WHILE_DENIED_SYMBOL, options);
