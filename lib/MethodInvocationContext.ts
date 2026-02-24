import { SaplRequest } from './SubscriptionContext';

export interface MethodInvocationContext {
  request: SaplRequest;
  args: any[];
  methodName: string;
  className: string;
}
