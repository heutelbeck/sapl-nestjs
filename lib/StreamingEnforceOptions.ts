import { SubscriptionOptions } from './EnforceOptions';
import { AuthorizationDecision } from './types';

/**
 * Restricted emitter passed to streaming callbacks. Only exposes `.next()` to
 * prevent user code from interfering with the stream lifecycle (error/complete)
 * which is managed by the enforcement aspect.
 */
export interface StreamEventEmitter {
  next(value: any): void;
}

export type OnStreamDenyHandler = (decision: AuthorizationDecision, emitter: StreamEventEmitter) => void;
export type OnStreamRecoverHandler = (decision: AuthorizationDecision, emitter: StreamEventEmitter) => void;

export interface EnforceTillDeniedOptions extends SubscriptionOptions {
  onStreamDeny?: OnStreamDenyHandler;
}

export interface EnforceDropWhileDeniedOptions extends SubscriptionOptions {
}

export interface EnforceRecoverableOptions extends SubscriptionOptions {
  onStreamDeny?: OnStreamDenyHandler;
  onStreamRecover?: OnStreamRecoverHandler;
}
