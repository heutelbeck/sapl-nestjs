import { MethodInvocationContext } from '../MethodInvocationContext';

export const NO_RESOURCE_REPLACEMENT = Symbol('NO_RESOURCE_REPLACEMENT');

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
    let current = this.replaceResource !== NO_RESOURCE_REPLACEMENT ? this.replaceResource : value;

    if (Array.isArray(current)) {
      current = current.filter(this.filterPredicateHandler);
    } else if (current !== null && !this.filterPredicateHandler(current)) {
      current = null;
    }

    this.doOnNextHandler(current);
    return this.mapNextHandler(current);
  }

  handleAllOnErrorConstraints(error: Error): Error {
    this.doOnErrorHandler(error);
    return this.mapErrorHandler(error);
  }
}
