import { Signal } from '../../../lib/constraints/api/index';

describe('Constraint Handler API', () => {
  describe('Signal', () => {
    test('whenAccessingOnDecisionThenReturnsExpectedValue', () => {
      expect(Signal.ON_DECISION).toBe('ON_DECISION');
    });

    test('whenEnumeratingSignalsThenOnlyOnDecisionExists', () => {
      const values = Object.values(Signal);
      expect(values).toEqual(['ON_DECISION']);
    });
  });
});
