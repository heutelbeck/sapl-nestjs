import { Signal } from '../../../lib/constraints/api/index';

describe('Constraint Handler API', () => {
  describe('Signal', () => {
    test('whenAccessingOnDecisionThenReturnsExpectedValue', () => {
      expect(Signal.ON_DECISION).toBe('ON_DECISION');
    });

    test('whenAccessingOnCompleteThenReturnsExpectedValue', () => {
      expect(Signal.ON_COMPLETE).toBe('ON_COMPLETE');
    });

    test('whenAccessingOnCancelThenReturnsExpectedValue', () => {
      expect(Signal.ON_CANCEL).toBe('ON_CANCEL');
    });

    test('whenEnumeratingSignalsThenExactlyThreeMembers', () => {
      const values = Object.values(Signal);
      expect(values).toEqual(['ON_DECISION', 'ON_COMPLETE', 'ON_CANCEL']);
    });
  });
});
