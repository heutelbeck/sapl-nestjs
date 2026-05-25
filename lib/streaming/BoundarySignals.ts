import { ForbiddenException } from '@nestjs/common';
import type { AuthorizationDecision } from '../types';

/**
 * Terminal denial. Subclass of NestJS's `ForbiddenException` so the
 * HTTP layer routes it as 403 natively without any glue. The optional
 * reason string is the operator-readable cause; subscribers that need
 * to react to a denial pattern-match on type, not on message content.
 */
export class AccessDeniedError extends ForbiddenException {
  constructor(reason = 'Access Denied by PDP') {
    super(reason);
    this.name = 'AccessDeniedError';
  }
}

/**
 * Non-terminal boundary signal emitted on `subscriber.next` when the
 * pipeline enters the Suspended state with `signalTransitions=true`.
 * Subscribers detect it via `instanceof` or
 * `TransitionSignals.onSuspend`. Empty body by trust-boundary rule:
 * the originating decision is upstream of the signal channel.
 */
export class AccessSuspendedSignal {}

/**
 * Non-terminal grant signal emitted on `subscriber.next` on entry into
 * the Permitting state from a non-Permitting state, when
 * `signalTransitions=true`. Carries the granting decision so
 * subscribers can audit which policy outcome resumed the stream.
 */
export class AccessGrantedSignal {
  readonly decision: AuthorizationDecision;

  constructor(decision: AuthorizationDecision) {
    this.decision = decision;
  }
}
