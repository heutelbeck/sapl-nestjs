import type { ClsService } from 'nestjs-cls';
import type { EnforcementPlan } from './Plan';

/**
 * CLS key under which the active enforcement plan is stored for the
 * duration of an enforced method invocation. Data-layer shims read it
 * at query time to discharge their query-manipulation signal.
 */
export const ACTIVE_PLAN_KEY = 'sapl:activePlan';

/**
 * Store the active plan for the current request scope. A no-op when no
 * CLS context is active: without a request scope there is no shim cut
 * point to read it, and writing outside a context would throw.
 */
export const setActivePlan = (cls: ClsService, plan: EnforcementPlan): void => {
  if (!cls.isActive()) return;
  cls.set(ACTIVE_PLAN_KEY, plan);
};

/**
 * The active plan for the current request scope, or undefined when no
 * plan is in scope (no enforced method on the stack, or no CLS context
 * at all, e.g. a background job). A shim treats undefined as "no
 * enforcement" and passes the query through unchanged, matching the
 * Python `current_plan() is None` contract.
 */
export const activePlan = (cls: ClsService): EnforcementPlan | undefined => {
  if (!cls.isActive()) return undefined;
  return cls.get<EnforcementPlan | undefined>(ACTIVE_PLAN_KEY);
};
