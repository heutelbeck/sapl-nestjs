import { ForbiddenException, Logger } from '@nestjs/common';
import { EnforceOptions } from './EnforceOptions';
import { SubscriptionContext } from './SubscriptionContext';
import { ConstraintEnforcementService } from './constraints/ConstraintEnforcementService';

export function applyDeny(options: EnforceOptions, ctx: SubscriptionContext, decision: any): any {
  if (options.onDeny) {
    return options.onDeny(ctx, decision);
  }
  throw new ForbiddenException('Access denied by policy');
}

export function handleDeny(
  logger: Logger,
  constraintService: ConstraintEnforcementService,
  decision: any,
  options: EnforceOptions,
  ctx: SubscriptionContext,
): any {
  if (decision.decision === 'INDETERMINATE') {
    logger.error(`PDP returned INDETERMINATE -- PDP may be unreachable or misconfigured`);
  } else {
    logger.warn(`Access denied: ${decision.decision}`);
  }

  try {
    const bundle = constraintService.bestEffortBundleFor(decision);
    bundle.handleOnDecisionConstraints();
  } catch (error) {
    logger.warn(`Best-effort obligation handlers failed on ${decision.decision}: ${error}`);
  }

  return applyDeny(options, ctx, decision);
}
