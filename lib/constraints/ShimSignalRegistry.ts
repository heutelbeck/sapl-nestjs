import type { SignalKind } from './Signal';

/**
 * Process-global registry of signal kinds advertised by data-layer
 * shims (Mongoose, Prisma). A shim registers its kind at module init so
 * the planner admits matching obligations instead of rejecting them as
 * INADMISSIBLE. Mirrors the Python `sapl_base.pep.shim_signals` registry
 * and Spring's ShimSignalContributor: the core lib stays decoupled from
 * the existence of any particular shim.
 *
 * Aspects union {@link shimSignals} into their own supported set when
 * building a plan, so a query-manipulation obligation is only admitted
 * when its shim is actually installed.
 */
const signals = new Set<SignalKind>();

/** Advertise a shim signal kind. Idempotent. */
export const registerShimSignal = (signal: SignalKind): void => {
  signals.add(signal);
};

/** Withdraw a shim signal kind. Idempotent. */
export const unregisterShimSignal = (signal: SignalKind): void => {
  signals.delete(signal);
};

/** A snapshot of the currently registered shim signal kinds. */
export const shimSignals = (): ReadonlySet<SignalKind> => new Set(signals);
