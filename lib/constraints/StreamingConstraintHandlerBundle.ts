export const NO_RESOURCE_REPLACEMENT = Symbol('NO_RESOURCE_REPLACEMENT');

export class StreamingConstraintHandlerBundle {
  constructor(
    private readonly onDecisionHandlers: () => void,
    private readonly onSubscribeHandlers: (subscription: any) => void,
    private readonly onRequestHandlers: (count: number) => void,
    private readonly replaceResource: any,
    private readonly filterPredicateHandler: (element: any) => boolean,
    private readonly doOnNextHandler: (value: any) => void,
    private readonly mapNextHandler: (value: any) => any,
    private readonly doOnErrorHandler: (error: Error) => void,
    private readonly mapErrorHandler: (error: Error) => Error,
    private readonly onCompleteHandlers: () => void,
    private readonly onCancelHandlers: () => void,
  ) {}

  handleOnDecisionConstraints(): void {
    this.onDecisionHandlers();
  }

  handleOnSubscribeConstraints(subscription: any): void {
    this.onSubscribeHandlers(subscription);
  }

  handleOnRequestConstraints(count: number): void {
    this.onRequestHandlers(count);
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

  handleOnCompleteConstraints(): void {
    this.onCompleteHandlers();
  }

  handleOnCancelConstraints(): void {
    this.onCancelHandlers();
  }
}
