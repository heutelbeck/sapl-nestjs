import { Subscriber } from 'rxjs';
import { SubscriptionOptions } from './EnforceOptions';
import { AuthorizationDecision } from './types';

export type OnStreamDenyHandler = (decision: AuthorizationDecision, subscriber: Subscriber<any>) => void;
export type OnStreamRecoverHandler = (decision: AuthorizationDecision, subscriber: Subscriber<any>) => void;

export interface EnforceTillDeniedOptions extends SubscriptionOptions {
  onStreamDeny?: OnStreamDenyHandler;
}

export interface EnforceDropWhileDeniedOptions extends SubscriptionOptions {
}

export interface EnforceRecoverableOptions extends SubscriptionOptions {
  onStreamDeny?: OnStreamDenyHandler;
  onStreamRecover?: OnStreamRecoverHandler;
}
