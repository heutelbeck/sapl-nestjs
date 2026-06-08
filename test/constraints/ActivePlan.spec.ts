import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { EnforcementPlan } from '../../lib/constraints/Plan';
import { activePlan, setActivePlan } from '../../lib/constraints/ActivePlan';

const newCls = (): ClsService =>
  new ClsService(new AsyncLocalStorage() as unknown as ConstructorParameters<typeof ClsService>[0]);

const emptyPlan = (): EnforcementPlan => new EnforcementPlan(new Map());

describe('activePlan', () => {
  it('returns undefined when there is no CLS context', () => {
    const cls = newCls();
    expect(activePlan(cls)).toBeUndefined();
  });

  it('returns undefined inside a context when no plan was set', () => {
    const cls = newCls();
    cls.run(() => {
      expect(activePlan(cls)).toBeUndefined();
    });
  });

  it('returns the plan set for the current context', () => {
    const cls = newCls();
    const plan = emptyPlan();
    cls.run(() => {
      setActivePlan(cls, plan);
      expect(activePlan(cls)).toBe(plan);
    });
  });

  it('propagates the plan to a nested async continuation', async () => {
    const cls = newCls();
    const plan = emptyPlan();
    await cls.run(async () => {
      setActivePlan(cls, plan);
      await Promise.resolve();
      expect(activePlan(cls)).toBe(plan);
    });
  });
});
