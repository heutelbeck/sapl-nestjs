import { Observable, filter, map, tap } from 'rxjs';
import { AccessSuspendedSignal } from './MealyMachine';
import { AccessGrantedSignal } from './BoundarySignals';

const isSuspendSignal = (value: unknown): value is AccessSuspendedSignal =>
  value instanceof AccessSuspendedSignal;

const isGrantedSignal = (value: unknown): value is AccessGrantedSignal =>
  value instanceof AccessGrantedSignal;

function onSuspend<T>(
  source: Observable<T>,
  consumer: (signal: AccessSuspendedSignal) => void,
): Observable<T>;
function onSuspend<T>(
  source: Observable<T>,
  consumer: (signal: AccessSuspendedSignal) => void,
  substitute: (signal: AccessSuspendedSignal) => T,
): Observable<T>;
function onSuspend<T>(
  source: Observable<T>,
  consumer: (signal: AccessSuspendedSignal) => void,
  substitute?: (signal: AccessSuspendedSignal) => T,
): Observable<T> {
  if (substitute === undefined) {
    return source.pipe(
      tap((value) => {
        if (isSuspendSignal(value)) {
          consumer(value);
        }
      }),
      filter((value) => !isSuspendSignal(value)),
    ) as Observable<T>;
  }
  return source.pipe(
    map((value): T => {
      if (isSuspendSignal(value)) {
        consumer(value);
        return substitute(value);
      }
      return value;
    }),
  );
}

function onGranted<T>(source: Observable<T>, consumer: (signal: AccessGrantedSignal) => void): Observable<T>;
function onGranted<T>(
  source: Observable<T>,
  consumer: (signal: AccessGrantedSignal) => void,
  substitute: (signal: AccessGrantedSignal) => T,
): Observable<T>;
function onGranted<T>(
  source: Observable<T>,
  consumer: (signal: AccessGrantedSignal) => void,
  substitute?: (signal: AccessGrantedSignal) => T,
): Observable<T> {
  if (substitute === undefined) {
    return source.pipe(
      tap((value) => {
        if (isGrantedSignal(value)) {
          consumer(value);
        }
      }),
      filter((value) => !isGrantedSignal(value)),
    ) as Observable<T>;
  }
  return source.pipe(
    map((value): T => {
      if (isGrantedSignal(value)) {
        consumer(value);
        return substitute(value);
      }
      return value;
    }),
  );
}

function onTransitions<T>(
  source: Observable<T>,
  suspendConsumer: (signal: AccessSuspendedSignal) => void,
  grantConsumer: (signal: AccessGrantedSignal) => void,
): Observable<T>;
function onTransitions<T>(
  source: Observable<T>,
  suspendConsumer: (signal: AccessSuspendedSignal) => void,
  suspendSubstitute: (signal: AccessSuspendedSignal) => T,
  grantConsumer: (signal: AccessGrantedSignal) => void,
  grantSubstitute: (signal: AccessGrantedSignal) => T,
): Observable<T>;
function onTransitions<T>(
  source: Observable<T>,
  suspendConsumer: (signal: AccessSuspendedSignal) => void,
  arg3: ((signal: AccessGrantedSignal) => void) | ((signal: AccessSuspendedSignal) => T),
  grantConsumer?: (signal: AccessGrantedSignal) => void,
  grantSubstitute?: (signal: AccessGrantedSignal) => T,
): Observable<T> {
  if (grantConsumer === undefined) {
    return onGranted(onSuspend(source, suspendConsumer), arg3 as (signal: AccessGrantedSignal) => void);
  }
  return onGranted(
    onSuspend(source, suspendConsumer, arg3 as (signal: AccessSuspendedSignal) => T),
    grantConsumer,
    grantSubstitute as (signal: AccessGrantedSignal) => T,
  );
}

/**
 * Subscriber-side helpers for unwrapping the in-band boundary signals
 * emitted by the streaming pipeline when `signalTransitions=true` is set
 * on `@StreamEnforce`. Each helper observes the boundary, invokes the
 * provided consumer, and either drops the signal from the stream or
 * substitutes a value of the source type. `onTransitions` is a
 * convenience composition of `onSuspend` and `onGranted`.
 */
export const TransitionSignals = {
  onSuspend,
  onGranted,
  onTransitions,
};
