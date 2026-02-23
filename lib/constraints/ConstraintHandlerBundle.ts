import { MethodInvocationContext } from '../MethodInvocationContext';
import { NO_RESOURCE_REPLACEMENT } from './api/index';

export function applyNextConstraints(
  value: any,
  replaceResource: any,
  filterPredicate: (element: any) => boolean,
  doOnNext: (value: any) => void,
  mapNext: (value: any) => any,
): any {
  let current = replaceResource !== NO_RESOURCE_REPLACEMENT ? replaceResource : value;

  if (Array.isArray(current)) {
    current = current.filter(filterPredicate);
  } else if (current != null && !filterPredicate(current)) {
    current = null;
  }

  doOnNext(current);
  return mapNext(current);
}

export function applyErrorConstraints(
  error: Error,
  doOnError: (error: Error) => void,
  mapError: (error: Error) => Error,
): Error {
  doOnError(error);
  return mapError(error);
}

export class ConstraintHandlerBundle {
  constructor(
    private readonly onDecisionHandlers: () => void,
    private readonly methodInvocationHandlers: (context: MethodInvocationContext) => void,
    private readonly replaceResource: any,
    private readonly filterPredicateHandler: (element: any) => boolean,
    private readonly doOnNextHandler: (value: any) => void,
    private readonly mapNextHandler: (value: any) => any,
    private readonly doOnErrorHandler: (error: Error) => void,
    private readonly mapErrorHandler: (error: Error) => Error,
  ) {}

  handleOnDecisionConstraints(): void {
    this.onDecisionHandlers();
  }

  handleMethodInvocationHandlers(context: MethodInvocationContext): void {
    this.methodInvocationHandlers(context);
  }

  handleAllOnNextConstraints(value: any): any {
    return applyNextConstraints(
      value,
      this.replaceResource,
      this.filterPredicateHandler,
      this.doOnNextHandler,
      this.mapNextHandler,
    );
  }

  handleAllOnErrorConstraints(error: Error): Error {
    return applyErrorConstraints(error, this.doOnErrorHandler, this.mapErrorHandler);
  }
}
