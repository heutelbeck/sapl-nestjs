export enum Signal {
  ON_DECISION = 'ON_DECISION',
  ON_COMPLETE = 'ON_COMPLETE',
  ON_CANCEL = 'ON_CANCEL',
}

export interface Responsible {
  isResponsible(constraint: any): boolean;
}

export interface RunnableConstraintHandlerProvider extends Responsible {
  getSignal(): Signal;
  getHandler(constraint: any): () => void;
}

export interface ConsumerConstraintHandlerProvider extends Responsible {
  getHandler(constraint: any): (value: any) => void;
}

export interface MappingConstraintHandlerProvider extends Responsible {
  getPriority(): number;
  getHandler(constraint: any): (value: any) => any;
}

export interface ErrorHandlerProvider extends Responsible {
  getHandler(constraint: any): (error: Error) => void;
}

export interface ErrorMappingConstraintHandlerProvider extends Responsible {
  getPriority(): number;
  getHandler(constraint: any): (error: Error) => Error;
}

export interface FilterPredicateConstraintHandlerProvider extends Responsible {
  getHandler(constraint: any): (element: any) => boolean;
}

import { MethodInvocationContext } from '../../MethodInvocationContext';

export interface MethodInvocationConstraintHandlerProvider extends Responsible {
  getHandler(constraint: any): (context: MethodInvocationContext) => void;
}

export interface SubscriptionHandlerProvider extends Responsible {
  getHandler(constraint: any): (subscription: any) => void;
}

export interface RequestHandlerProvider extends Responsible {
  getHandler(constraint: any): (count: number) => void;
}
