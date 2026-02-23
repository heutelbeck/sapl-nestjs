import { Subscriber } from 'rxjs';
import { SubscriptionOptions } from './EnforceOptions';

export type OnStreamDenyHandler = (decision: any, subscriber: Subscriber<any>) => void;
export type OnStreamRecoverHandler = (decision: any, subscriber: Subscriber<any>) => void;

export interface EnforceTillDeniedOptions extends SubscriptionOptions {
  onStreamDeny?: OnStreamDenyHandler;
}

export interface EnforceDropWhileDeniedOptions extends SubscriptionOptions {
}

export interface EnforceRecoverableOptions extends SubscriptionOptions {
  onStreamDeny?: OnStreamDenyHandler;
  onStreamRecover?: OnStreamRecoverHandler;
}
