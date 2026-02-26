import { ForbiddenException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { MethodInvocationContext } from '../MethodInvocationContext';
import { SaplConstraintHandler, ConstraintHandlerType } from './SaplConstraintHandler';
import { ConstraintHandlerBundle } from './ConstraintHandlerBundle';
import { StreamingConstraintHandlerBundle } from './StreamingConstraintHandlerBundle';
import { AuthorizationDecision } from '../types';
import {
  NO_RESOURCE_REPLACEMENT,
  Signal,
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
  return () => {
    let firstError: unknown = null;
    try { a(); } catch (e) { firstError = e; }
    try { b(); } catch (e) { if (!firstError) firstError = e; }
    if (firstError) throw firstError;
  };
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

interface ProcessOptions {
  signal?: Signal;
  sortByPriority?: boolean;
  adviceFallback?: unknown;
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

  preEnforceBundleFor(decision: AuthorizationDecision): ConstraintHandlerBundle {
    return this.buildBundle(decision, true, false);
  }

  postEnforceBundleFor(decision: AuthorizationDecision): ConstraintHandlerBundle {
    return this.buildBundle(decision, false, false);
  }

  bestEffortBundleFor(decision: AuthorizationDecision): ConstraintHandlerBundle {
    return this.buildBundle(decision, false, true);
  }

  streamingBundleFor(decision: AuthorizationDecision): StreamingConstraintHandlerBundle {
    return this.buildStreamingBundle(decision, false);
  }

  streamingBestEffortBundleFor(decision: AuthorizationDecision): StreamingConstraintHandlerBundle {
    return this.buildStreamingBundle(decision, true);
  }

  private processHandlers(
    providers: any[],
    constraint: unknown,
    index: number,
    unhandled: Set<number> | undefined,
    isObligation: boolean,
    compose: (handler: any) => void,
    options?: ProcessOptions,
  ): void {
    let responsible = providers.filter((p) => p.isResponsible(constraint));

    if (options?.signal !== undefined) {
      responsible = responsible.filter((p) => p.getSignal() === options.signal);
    }

    if (options?.sortByPriority) {
      responsible.sort((a, b) => b.getPriority() - a.getPriority());
    }

    for (const provider of responsible) {
      unhandled?.delete(index);
      const raw = provider.getHandler(constraint);
      let wrapped;
      if (isObligation) {
        wrapped = wrapObligation(raw, constraint, this.logger);
      } else if (options?.sortByPriority) {
        wrapped = wrapAdvicePassthrough(raw, constraint, this.logger);
      } else {
        wrapped = wrapAdvice(raw, constraint, this.logger, options?.adviceFallback);
      }
      compose(wrapped);
    }
  }

  private collectHandlers(
    decision: AuthorizationDecision,
    bestEffort: boolean,
    runnableSignals: Signal[],
    includeMethodInvocation: boolean,
  ) {
    const obligations: any[] = decision.obligations ?? [];
    const advice: any[] = decision.advice ?? [];
    const unhandledObligations = new Set<number>(obligations.map((_, i) => i));

    const runnables = new Map<Signal, () => void>();
    for (const signal of runnableSignals) {
      runnables.set(signal, () => {});
    }
    let methodInvocation: (context: MethodInvocationContext) => void = () => {};
    let filterPredicate: (element: any) => boolean = () => true;
    let doOnNext: (value: any) => void = () => {};
    let mapNext: (value: any) => any = (v) => v;
    let doOnError: (error: Error) => void = () => {};
    let mapError: (error: Error) => Error = (e) => e;

    const replaceResource = decision.resource !== undefined ? decision.resource : NO_RESOURCE_REPLACEMENT;

    const processConstraint = (constraint: any, isObligation: boolean, unhandled: Set<number> | undefined, i: number) => {
      for (const signal of runnableSignals) {
        this.processHandlers(this.handlers.runnable, constraint, i, unhandled, isObligation, (h) => {
          runnables.set(signal, runBoth(runnables.get(signal)!, h));
        }, { signal });
      }

      if (includeMethodInvocation) {
        this.processHandlers(this.handlers.methodInvocation, constraint, i, unhandled, isObligation, (h) => {
          methodInvocation = consumeWithBoth(methodInvocation, h);
        });
      }

      this.processHandlers(this.handlers.filterPredicate, constraint, i, unhandled, isObligation, (h) => {
        filterPredicate = filterBoth(filterPredicate, h);
      }, { adviceFallback: true });

      this.processHandlers(this.handlers.consumer, constraint, i, unhandled, isObligation, (h) => {
        doOnNext = consumeWithBoth(doOnNext, h);
      });

      this.processHandlers(this.handlers.mapping, constraint, i, unhandled, isObligation, (h) => {
        mapNext = mapBoth(mapNext, h);
      }, { sortByPriority: true });

      this.processHandlers(this.handlers.errorHandler, constraint, i, unhandled, isObligation, (h) => {
        doOnError = errorConsumeBoth(doOnError, h);
      });

      this.processHandlers(this.handlers.errorMapping, constraint, i, unhandled, isObligation, (h) => {
        mapError = errorMapBoth(mapError, h);
      }, { sortByPriority: true });
    };

    const obligationIsStrict = !bestEffort;
    for (let i = 0; i < obligations.length; i++) {
      processConstraint(obligations[i], obligationIsStrict, unhandledObligations, i);
    }

    if (!bestEffort && unhandledObligations.size > 0) {
      const unhandled = [...unhandledObligations].map((i) => obligations[i]);
      this.logger.error(`Unhandled obligations: ${JSON.stringify(unhandled)}`);
      throw new ForbiddenException('Access denied: unhandled obligation constraints');
    }

    for (let i = 0; i < advice.length; i++) {
      processConstraint(advice[i], false, undefined, i);
    }

    return { runnables, methodInvocation, replaceResource, filterPredicate, doOnNext, mapNext, doOnError, mapError };
  }

  private buildBundle(
    decision: AuthorizationDecision,
    includeMethodInvocation: boolean,
    bestEffort: boolean,
  ): ConstraintHandlerBundle {
    const h = this.collectHandlers(decision, bestEffort, [Signal.ON_DECISION], includeMethodInvocation);
    return new ConstraintHandlerBundle(
      h.runnables.get(Signal.ON_DECISION)!,
      h.methodInvocation,
      h.replaceResource,
      h.filterPredicate,
      h.doOnNext,
      h.mapNext,
      h.doOnError,
      h.mapError,
    );
  }

  private buildStreamingBundle(
    decision: AuthorizationDecision,
    bestEffort: boolean,
  ): StreamingConstraintHandlerBundle {
    const h = this.collectHandlers(
      decision, bestEffort,
      [Signal.ON_DECISION, Signal.ON_COMPLETE, Signal.ON_CANCEL],
      false,
    );
    return new StreamingConstraintHandlerBundle(
      h.runnables.get(Signal.ON_DECISION)!,
      h.replaceResource,
      h.filterPredicate,
      h.doOnNext,
      h.mapNext,
      h.doOnError,
      h.mapError,
      h.runnables.get(Signal.ON_COMPLETE)!,
      h.runnables.get(Signal.ON_CANCEL)!,
    );
  }

}
