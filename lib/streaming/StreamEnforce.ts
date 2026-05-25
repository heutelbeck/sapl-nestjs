import { createDecorator } from '@toss/nestjs-aop';
import type { SubscriptionOptions } from '../SubscriptionOptions';

export const STREAM_ENFORCE_SYMBOL = Symbol('sapl:stream-enforce');

/**
 * Options for the streaming-PEP decorator.
 */
export interface StreamEnforceOptions extends SubscriptionOptions {
  /**
   * Surface every suspend / resume boundary on the subscriber's `next`
   * channel as a non-terminal value typed `AccessSuspendedSignal` or
   * `AccessGrantedSignal`. Subscribers detect these via instanceof or
   * via the `TransitionSignals` helper operators. Terminal denial still
   * arrives on the `error` channel as `AccessDeniedError`. Defaults to false.
   */
  signalTransitions?: boolean;

  /**
   * Dispose the protected method's Observable on entry into the
   * Suspended state and re-subscribe on resume into Permitting.
   * Defaults to false, in which case the RAP stays connected and the
   * pipeline drops emissions while suspended.
   */
  pauseRapDuringSuspend?: boolean;
}

/**
 * Streaming-PEP decorator. The protected method must return an
 * `Observable`. The aspect drives a fresh streaming pipeline per
 * invocation, classifies each PDP decision under strict fail-closed
 * semantics, and renders the FSM's emissions onto the subscriber.
 */
export const StreamEnforce = (options: StreamEnforceOptions = {}) =>
  createDecorator(STREAM_ENFORCE_SYMBOL, options);
