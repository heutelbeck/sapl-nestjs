import { Subscriber } from 'rxjs';
import { EnforceOptions } from './EnforceOptions';

export type OnStreamDenyHandler = (decision: any, subscriber: Subscriber<any>) => void;
export type OnStreamRecoverHandler = (decision: any, subscriber: Subscriber<any>) => void;

export interface EnforceTillDeniedOptions extends EnforceOptions {
  onStreamDeny?: OnStreamDenyHandler;
}

export interface EnforceDropWhileDeniedOptions extends EnforceOptions {
}

export interface EnforceRecoverableOptions extends EnforceOptions {
  onStreamDeny?: OnStreamDenyHandler;
  onStreamRecover?: OnStreamRecoverHandler;
}
