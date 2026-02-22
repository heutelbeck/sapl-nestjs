export enum Signal {
  ON_DECISION = 'ON_DECISION',
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

export interface MethodInvocationConstraintHandlerProvider extends Responsible {
  getHandler(constraint: any): (request: any) => void;
}
