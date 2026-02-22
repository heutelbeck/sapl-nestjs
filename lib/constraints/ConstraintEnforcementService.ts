import { ForbiddenException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { SaplConstraintHandler, ConstraintHandlerType } from './SaplConstraintHandler';
import { ConstraintHandlerBundle, NO_RESOURCE_REPLACEMENT } from './ConstraintHandlerBundle';
import {
  Signal,
  Responsible,
  RunnableConstraintHandlerProvider,
  ConsumerConstraintHandlerProvider,
  MappingConstraintHandlerProvider,
  ErrorHandlerProvider,
  ErrorMappingConstraintHandlerProvider,
  FilterPredicateConstraintHandlerProvider,
  MethodInvocationConstraintHandlerProvider,
} from './api/index';

type HandlerLists = {
  runnable: RunnableConstraintHandlerProvider[];
  consumer: ConsumerConstraintHandlerProvider[];
  mapping: MappingConstraintHandlerProvider[];
  errorHandler: ErrorHandlerProvider[];
  errorMapping: ErrorMappingConstraintHandlerProvider[];
  filterPredicate: FilterPredicateConstraintHandlerProvider[];
  methodInvocation: MethodInvocationConstraintHandlerProvider[];
};

function runBoth(a: () => void, b: () => void): () => void {
  return () => { a(); b(); };
}

function consumeWithBoth(
  a: (v: any) => void,
  b: (v: any) => void,
): (v: any) => void {
  return (v) => { a(v); b(v); };
}

function mapBoth(
  a: (v: any) => any,
  b: (v: any) => any,
): (v: any) => any {
  return (v) => b(a(v));
}

function filterBoth(
  a: (v: any) => boolean,
  b: (v: any) => boolean,
): (v: any) => boolean {
  return (v) => a(v) && b(v);
}

function errorConsumeBoth(
  a: (e: Error) => void,
  b: (e: Error) => void,
): (e: Error) => void {
  return (e) => { a(e); b(e); };
}

function errorMapBoth(
  a: (e: Error) => Error,
  b: (e: Error) => Error,
): (e: Error) => Error {
  return (e) => b(a(e));
}

function wrapObligation<A extends any[], R>(
  handler: (...args: A) => R,
  constraint: any,
  logger: Logger,
): (...args: A) => R {
  return (...args: A): R => {
    try {
      return handler(...args);
    } catch (error) {
      logger.error(
        `Obligation handler failed for ${JSON.stringify(constraint)}: ${error}`,
      );
      throw new ForbiddenException('Access denied: obligation handler failed');
    }
  };
}

function wrapAdvice<A extends any[], R>(
  handler: (...args: A) => R,
  constraint: any,
  logger: Logger,
  fallback: R,
): (...args: A) => R {
  return (...args: A): R => {
    try {
      return handler(...args);
    } catch (error) {
      logger.warn(
        `Advice handler failed for ${JSON.stringify(constraint)}: ${error}`,
      );
      return fallback;
    }
  };
}

function wrapAdvicePassthrough<V>(
  handler: (v: V) => V,
  constraint: any,
  logger: Logger,
): (v: V) => V {
  return (v: V): V => {
    try {
      return handler(v);
    } catch (error) {
      logger.warn(
        `Advice handler failed for ${JSON.stringify(constraint)}: ${error}`,
      );
      return v;
    }
  };
}

@Injectable()
export class ConstraintEnforcementService implements OnModuleInit {
  private readonly logger = new Logger(ConstraintEnforcementService.name);
  private readonly handlers: HandlerLists = {
    runnable: [],
    consumer: [],
    mapping: [],
    errorHandler: [],
    errorMapping: [],
    filterPredicate: [],
    methodInvocation: [],
  };

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit() {
    const providers = this.discovery.getProviders({
      metadataKey: SaplConstraintHandler.KEY,
    });

    for (const wrapper of providers) {
      if (!wrapper.instance) continue;

      const metadata = this.discovery.getMetadataByDecorator(
        SaplConstraintHandler,
        wrapper,
      ) as ConstraintHandlerType | undefined;

      if (!metadata) continue;

      const instance = wrapper.instance as any;
      this.handlers[metadata].push(instance);

      this.logger.log(
        `Registered ${metadata} constraint handler: ${instance.constructor.name}`,
      );
    }
  }

  preEnforceBundleFor(decision: any): ConstraintHandlerBundle {
    return this.buildBundle(decision, true, false);
  }

  postEnforceBundleFor(decision: any): ConstraintHandlerBundle {
    return this.buildBundle(decision, false, false);
  }

  bestEffortBundleFor(decision: any): ConstraintHandlerBundle {
    return this.buildBundle(decision, false, true);
  }

  private buildBundle(
    decision: any,
    includeMethodInvocation: boolean,
    bestEffort: boolean,
  ): ConstraintHandlerBundle {
    const obligations: any[] = decision.obligations ?? [];
    const advice: any[] = decision.advice ?? [];
    const unhandledObligations = new Set<number>(obligations.map((_, i) => i));

    let onDecision: () => void = () => {};
    let methodInvocation: (request: any) => void = () => {};
    let filterPredicate: (element: any) => boolean = () => true;
    let doOnNext: (value: any) => void = () => {};
    let mapNext: (value: any) => any = (v) => v;
    let doOnError: (error: Error) => void = () => {};
    let mapError: (error: Error) => Error = (e) => e;

    const replaceResource = decision.resource !== undefined ? decision.resource : NO_RESOURCE_REPLACEMENT;

    const obligationIsStrict = !bestEffort;

    for (let i = 0; i < obligations.length; i++) {
      const constraint = obligations[i];

      this.processRunnables(constraint, obligationIsStrict, unhandledObligations, i, (h) => {
        onDecision = runBoth(onDecision, h);
      });

      if (includeMethodInvocation) {
        this.processMethodInvocation(constraint, obligationIsStrict, unhandledObligations, i, (h) => {
          methodInvocation = this.composeMethodInvocation(methodInvocation, h);
        });
      }

      this.processFilterPredicates(constraint, obligationIsStrict, unhandledObligations, i, (h) => {
        filterPredicate = filterBoth(filterPredicate, h);
      });

      this.processConsumers(constraint, obligationIsStrict, unhandledObligations, i, (h) => {
        doOnNext = consumeWithBoth(doOnNext, h);
      });

      this.processMappings(constraint, obligationIsStrict, unhandledObligations, i, (h) => {
        mapNext = mapBoth(mapNext, h);
      });

      this.processErrorHandlers(constraint, obligationIsStrict, unhandledObligations, i, (h) => {
        doOnError = errorConsumeBoth(doOnError, h);
      });

      this.processErrorMappings(constraint, obligationIsStrict, unhandledObligations, i, (h) => {
        mapError = errorMapBoth(mapError, h);
      });
    }

    if (!bestEffort && unhandledObligations.size > 0) {
      const unhandled = [...unhandledObligations].map((i) => obligations[i]);
      this.logger.error(
        `Unhandled obligations: ${JSON.stringify(unhandled)}`,
      );
      throw new ForbiddenException(
        'Access denied: unhandled obligation constraints',
      );
    }

    for (let i = 0; i < advice.length; i++) {
      const constraint = advice[i];

      this.processRunnables(constraint, false, undefined, i, (h) => {
        onDecision = runBoth(onDecision, h);
      });

      if (includeMethodInvocation) {
        this.processMethodInvocation(constraint, false, undefined, i, (h) => {
          methodInvocation = this.composeMethodInvocation(methodInvocation, h);
        });
      }

      this.processFilterPredicates(constraint, false, undefined, i, (h) => {
        filterPredicate = filterBoth(filterPredicate, h);
      });

      this.processConsumers(constraint, false, undefined, i, (h) => {
        doOnNext = consumeWithBoth(doOnNext, h);
      });

      this.processMappings(constraint, false, undefined, i, (h) => {
        mapNext = mapBoth(mapNext, h);
      });

      this.processErrorHandlers(constraint, false, undefined, i, (h) => {
        doOnError = errorConsumeBoth(doOnError, h);
      });

      this.processErrorMappings(constraint, false, undefined, i, (h) => {
        mapError = errorMapBoth(mapError, h);
      });
    }

    return new ConstraintHandlerBundle(
      onDecision,
      methodInvocation,
      replaceResource,
      filterPredicate,
      doOnNext,
      mapNext,
      doOnError,
      mapError,
    );
  }

  private processRunnables(
    constraint: any,
    isObligation: boolean,
    unhandled: Set<number> | undefined,
    index: number,
    compose: (handler: () => void) => void,
  ): void {
    for (const provider of this.handlers.runnable) {
      if (!provider.isResponsible(constraint)) continue;
      if (provider.getSignal() !== Signal.ON_DECISION) continue;
      unhandled?.delete(index);
      const raw = provider.getHandler(constraint);
      const wrapped = isObligation
        ? wrapObligation(raw, constraint, this.logger)
        : wrapAdvice(raw, constraint, this.logger, undefined as any);
      compose(wrapped);
    }
  }

  private processMethodInvocation(
    constraint: any,
    isObligation: boolean,
    unhandled: Set<number> | undefined,
    index: number,
    compose: (handler: (request: any) => void) => void,
  ): void {
    for (const provider of this.handlers.methodInvocation) {
      if (!provider.isResponsible(constraint)) continue;
      unhandled?.delete(index);
      const raw = provider.getHandler(constraint);
      const wrapped = isObligation
        ? wrapObligation(raw, constraint, this.logger)
        : wrapAdvice(raw, constraint, this.logger, undefined as any);
      compose(wrapped);
    }
  }

  private processFilterPredicates(
    constraint: any,
    isObligation: boolean,
    unhandled: Set<number> | undefined,
    index: number,
    compose: (handler: (element: any) => boolean) => void,
  ): void {
    for (const provider of this.handlers.filterPredicate) {
      if (!provider.isResponsible(constraint)) continue;
      unhandled?.delete(index);
      const raw = provider.getHandler(constraint);
      const wrapped = isObligation
        ? wrapObligation(raw, constraint, this.logger)
        : wrapAdvice(raw, constraint, this.logger, true);
      compose(wrapped);
    }
  }

  private processConsumers(
    constraint: any,
    isObligation: boolean,
    unhandled: Set<number> | undefined,
    index: number,
    compose: (handler: (value: any) => void) => void,
  ): void {
    for (const provider of this.handlers.consumer) {
      if (!provider.isResponsible(constraint)) continue;
      unhandled?.delete(index);
      const raw = provider.getHandler(constraint);
      const wrapped = isObligation
        ? wrapObligation(raw, constraint, this.logger)
        : wrapAdvice(raw, constraint, this.logger, undefined as any);
      compose(wrapped);
    }
  }

  private processMappings(
    constraint: any,
    isObligation: boolean,
    unhandled: Set<number> | undefined,
    index: number,
    compose: (handler: (value: any) => any) => void,
  ): void {
    const responsible = this.handlers.mapping
      .filter((p) => p.isResponsible(constraint))
      .sort((a, b) => b.getPriority() - a.getPriority());

    for (const provider of responsible) {
      unhandled?.delete(index);
      const raw = provider.getHandler(constraint);
      const wrapped = isObligation
        ? wrapObligation(raw, constraint, this.logger)
        : wrapAdvicePassthrough(raw, constraint, this.logger);
      compose(wrapped);
    }
  }

  private processErrorHandlers(
    constraint: any,
    isObligation: boolean,
    unhandled: Set<number> | undefined,
    index: number,
    compose: (handler: (error: Error) => void) => void,
  ): void {
    for (const provider of this.handlers.errorHandler) {
      if (!provider.isResponsible(constraint)) continue;
      unhandled?.delete(index);
      const raw = provider.getHandler(constraint);
      const wrapped = isObligation
        ? wrapObligation(raw, constraint, this.logger)
        : wrapAdvice(raw, constraint, this.logger, undefined as any);
      compose(wrapped);
    }
  }

  private processErrorMappings(
    constraint: any,
    isObligation: boolean,
    unhandled: Set<number> | undefined,
    index: number,
    compose: (handler: (error: Error) => Error) => void,
  ): void {
    const responsible = this.handlers.errorMapping
      .filter((p) => p.isResponsible(constraint))
      .sort((a, b) => b.getPriority() - a.getPriority());

    for (const provider of responsible) {
      unhandled?.delete(index);
      const raw = provider.getHandler(constraint);
      const wrapped = isObligation
        ? wrapObligation(raw, constraint, this.logger)
        : wrapAdvicePassthrough(raw, constraint, this.logger);
      compose(wrapped);
    }
  }

  private composeMethodInvocation(
    a: (request: any) => void,
    b: (request: any) => void,
  ): (request: any) => void {
    return (request) => { a(request); b(request); };
  }
}
