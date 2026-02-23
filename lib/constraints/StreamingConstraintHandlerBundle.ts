import { applyNextConstraints, applyErrorConstraints } from './ConstraintHandlerBundle';

export class StreamingConstraintHandlerBundle {
  constructor(
    private readonly onDecisionHandlers: () => void,
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

  handleOnCompleteConstraints(): void {
    this.onCompleteHandlers();
  }

  handleOnCancelConstraints(): void {
    this.onCancelHandlers();
  }
}
