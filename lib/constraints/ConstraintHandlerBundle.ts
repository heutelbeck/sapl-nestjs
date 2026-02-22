export class ConstraintHandlerBundle {
  constructor(
    private readonly onDecisionHandlers: () => void,
    private readonly methodInvocationHandlers: (request: any) => void,
    private readonly replaceResource: any | null,
    private readonly filterPredicateHandler: (element: any) => boolean,
    private readonly doOnNextHandler: (value: any) => void,
    private readonly mapNextHandler: (value: any) => any,
    private readonly doOnErrorHandler: (error: Error) => void,
    private readonly mapErrorHandler: (error: Error) => Error,
  ) {}

  handleOnDecisionConstraints(): void {
    this.onDecisionHandlers();
  }

  handleMethodInvocationHandlers(request: any): void {
    this.methodInvocationHandlers(request);
  }

  handleAllOnNextConstraints(value: any): any {
    let current = this.replaceResource !== null ? this.replaceResource : value;

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
