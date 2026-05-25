import { Logger } from '@nestjs/common';
import { EnforcementPlanner } from './constraints/Planner';
import type { SignalKind } from './constraints/Signal';
import { AccessDeniedError } from './streaming/BoundarySignals';

const DENY_SIGNALS: ReadonlySet<SignalKind> = new Set<SignalKind>(['decision']);

export function handleDeny(logger: Logger, planner: EnforcementPlanner, decision: any): never {
  let reason: string;
  switch (decision.decision) {
    case 'INDETERMINATE':
      logger.error('PDP returned INDETERMINATE -- PDP may be unreachable or misconfigured');
      reason = 'PDP returned indeterminate';
      break;
    case 'NOT_APPLICABLE':
      logger.warn('Access denied: NOT_APPLICABLE');
      reason = 'No applicable policy';
      break;
    default:
      logger.warn(`Access denied: ${decision.decision}`);
      reason = 'Access denied by policy';
  }

  // Discharge advice handlers attached to the decision signal. Best-effort:
  // obligations on the deny path are not expected in well-formed policies;
  // their failure is logged via the planner's failure runner.
  const plan = planner.plan(decision, DENY_SIGNALS);
  plan.execute({ kind: 'decision', value: decision });

  throw new AccessDeniedError(reason);
}
