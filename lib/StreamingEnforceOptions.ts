import { SubscriptionOptions } from './EnforceOptions';
import { AuthorizationDecision } from './types';

/**
 * Restricted emitter passed to streaming callbacks. Exposes ONLY `next()` to
 * inject events into the stream. Lifecycle management (error/complete) is the
 * exclusive responsibility of the enforcement aspect (REQ-CALLBACK-RESTRICT-1).
 */
export interface RestrictedStreamEventEmitter {
  next(value: any): void;
}

/**
 * @deprecated Use {@link RestrictedStreamEventEmitter} instead. Callbacks
 * should not have access to error() or complete() per REQ-CALLBACK-RESTRICT-1.
 */
export interface StreamEventEmitter {
  next(value: any): void;
  error(err: any): void;
  complete(): void;
}

export type OnStreamDenyHandler = (decision: AuthorizationDecision, emitter: RestrictedStreamEventEmitter) => void;
export type OnStreamRecoverHandler = (decision: AuthorizationDecision, emitter: RestrictedStreamEventEmitter) => void;

export interface EnforceTillDeniedOptions extends SubscriptionOptions {
  onStreamDeny?: OnStreamDenyHandler;
}

export interface EnforceDropWhileDeniedOptions extends SubscriptionOptions {}

export interface EnforceRecoverableOptions extends SubscriptionOptions {
  onStreamDeny?: OnStreamDenyHandler;
  onStreamRecover?: OnStreamRecoverHandler;
}
