import { getHandler, predicateFromConditions } from '../../../lib/constraints/providers/ContentFilter';

describe('ContentFilter', () => {
  describe('getHandler', () => {
    describe('delete action', () => {
      test('whenDeleteActionThenRemovesField', () => {
        const handler = getHandler({
          actions: [{ type: 'delete', path: '$.ssn' }],
        });
        const result = handler({ name: 'Jane', ssn: '123-45-6789' });
        expect(result).toEqual({ name: 'Jane' });
        expect(result).not.toHaveProperty('ssn');
      });

      test('whenDeleteNestedPathThenRemovesNestedField', () => {
        const handler = getHandler({
          actions: [{ type: 'delete', path: '$.address.zip' }],
        });
        expect(handler({ address: { city: 'NYC', zip: '10001' } }))
          .toEqual({ address: { city: 'NYC' } });
      });

      test('whenDeleteDeeplyNestedPathThenRemovesField', () => {
        const handler = getHandler({
          actions: [{ type: 'delete', path: '$.a.b.c.d' }],
        });
        expect(handler({ a: { b: { c: { d: 'secret', e: 'keep' } } } }))
          .toEqual({ a: { b: { c: { e: 'keep' } } } });
      });
    });

    describe('replace action', () => {
      test('whenReplaceActionThenSubstitutesValue', () => {
        const handler = getHandler({
          actions: [{ type: 'replace', path: '$.ssn', replacement: 'REDACTED' }],
        });
        expect(handler({ name: 'Jane', ssn: '123-45-6789' }))
          .toEqual({ name: 'Jane', ssn: 'REDACTED' });
      });

      test('whenReplaceWithNullThenSetsNull', () => {
        const handler = getHandler({
          actions: [{ type: 'replace', path: '$.data', replacement: null }],
        });
        expect(handler({ data: 'secret' })).toEqual({ data: null });
      });
    });

    describe('blacken action', () => {
      test('whenBlackenWithDefaultsThenMasksEntireStringWithBlackSquare', () => {
        const handler = getHandler({
          actions: [{ type: 'blacken', path: '$.ssn' }],
        });
        expect(handler({ ssn: '123-45-6789' }).ssn).toBe('\u2588'.repeat(11));
      });

      test('whenBlackenWithDiscloseLeftAndRightThenPreservesEnds', () => {
        const handler = getHandler({
          actions: [{
            type: 'blacken',
            path: '$.email',
            replacement: 'X',
            discloseLeft: 2,
            discloseRight: 4,
          }],
        });
        expect(handler({ email: 'jane.doe@example.com' }).email)
          .toBe('ja' + 'X'.repeat(14) + '.com');
      });

      test('whenBlackenWithCustomReplacementThenUsesIt', () => {
        const handler = getHandler({
          actions: [{ type: 'blacken', path: '$.name', replacement: '*' }],
        });
        expect(handler({ name: 'Jane' }).name).toBe('****');
      });

      test('whenBlackenNonStringThenThrowsError', () => {
        const handler = getHandler({
          actions: [{ type: 'blacken', path: '$.age' }],
        });
        expect(() => handler({ age: 30 })).toThrow('not a text node');
      });

      test('whenBlackenEmptyStringThenReturnsEmpty', () => {
        const handler = getHandler({
          actions: [{ type: 'blacken', path: '$.name', replacement: '*' }],
        });
        expect(handler({ name: '' }).name).toBe('');
      });

      test('whenBlackenWithLengthThenOverridesMaskedLength', () => {
        const handler = getHandler({
          actions: [{ type: 'blacken', path: '$.ssn', replacement: '*', length: 3 }],
        });
        expect(handler({ ssn: '123-45-6789' }).ssn).toBe('***');
      });

      test('whenBlackenWithLengthAndDiscloseThenCombines', () => {
        const handler = getHandler({
          actions: [{
            type: 'blacken',
            path: '$.ssn',
            replacement: '*',
            length: 5,
            discloseLeft: 2,
            discloseRight: 2,
          }],
        });
        expect(handler({ ssn: '123-45-6789' }).ssn).toBe('12*****89');
      });

      test('whenBlackenWithLengthZeroThenNoMaskedChars', () => {
        const handler = getHandler({
          actions: [{ type: 'blacken', path: '$.name', replacement: '*', length: 0 }],
        });
        expect(handler({ name: 'Jane' }).name).toBe('');
      });

      test('whenDiscloseExceedsLengthThenReturnOriginal', () => {
        const handler = getHandler({
          actions: [{
            type: 'blacken',
            path: '$.short',
            replacement: '*',
            discloseLeft: 5,
            discloseRight: 5,
          }],
        });
        expect(handler({ short: 'ab' }).short).toBe('ab');
      });
    });

    describe('multiple actions', () => {
      test('whenMultipleActionsThenAppliedInOrder', () => {
        const handler = getHandler({
          actions: [
            { type: 'blacken', path: '$.ssn', replacement: '*', discloseRight: 4 },
            { type: 'delete', path: '$.email' },
          ],
        });
        const result = handler({ ssn: '123-45-6789', email: 'test@test.com', name: 'Jane' });
        expect(result).toEqual({ ssn: '*******6789', name: 'Jane' });
        expect(result).not.toHaveProperty('email');
      });
    });

    describe('conditions', () => {
      test('whenConditionMetThenActionsApply', () => {
        const handler = getHandler({
          conditions: [{ path: '$.role', type: '==', value: 'patient' }],
          actions: [{ type: 'delete', path: '$.ssn' }],
        });
        expect(handler({ role: 'patient', ssn: '123-45-6789' }))
          .not.toHaveProperty('ssn');
      });

      test('whenConditionNotMetThenNoActions', () => {
        const handler = getHandler({
          conditions: [{ path: '$.role', type: '==', value: 'patient' }],
          actions: [{ type: 'delete', path: '$.ssn' }],
        });
        expect(handler({ role: 'doctor', ssn: '123-45-6789' }).ssn)
          .toBe('123-45-6789');
      });

      test('whenMultipleConditionsThenAllMustMatch', () => {
        const handler = getHandler({
          conditions: [
            { path: '$.role', type: '==', value: 'patient' },
            { path: '$.age', type: '>=', value: 18 },
          ],
          actions: [{ type: 'replace', path: '$.status', replacement: 'adult-patient' }],
        });
        expect(handler({ role: 'patient', age: 20, status: 'unknown' }).status).toBe('adult-patient');
        expect(handler({ role: 'patient', age: 16, status: 'unknown' }).status).toBe('unknown');
        expect(handler({ role: 'doctor', age: 20, status: 'unknown' }).status).toBe('unknown');
      });
    });

    describe('arrays', () => {
      test('whenArrayInputThenTransformEachElement', () => {
        const handler = getHandler({
          actions: [{ type: 'delete', path: '$.ssn' }],
        });
        expect(handler([
          { name: 'A', ssn: '111' },
          { name: 'B', ssn: '222' },
        ])).toEqual([{ name: 'A' }, { name: 'B' }]);
      });

      test('whenArrayWithConditionsThenOnlyMatchingElementsTransformed', () => {
        const handler = getHandler({
          conditions: [{ path: '$.active', type: '==', value: true }],
          actions: [{ type: 'delete', path: '$.internal' }],
        });
        expect(handler([
          { active: true, internal: 'x', name: 'A' },
          { active: false, internal: 'y', name: 'B' },
        ])).toEqual([
          { active: true, name: 'A' },
          { active: false, internal: 'y', name: 'B' },
        ]);
      });

      test('whenArrayContainsNullElementsThenNullsPassThrough', () => {
        const handler = getHandler({
          actions: [{ type: 'delete', path: '$.ssn' }],
        });
        expect(handler([{ name: 'A', ssn: '111' }, null, { name: 'B', ssn: '222' }]))
          .toEqual([{ name: 'A' }, null, { name: 'B' }]);
      });
    });

    describe('edge cases', () => {
      test('whenNullInputThenReturnsNull', () => {
        const handler = getHandler({ actions: [{ type: 'delete', path: '$.x' }] });
        expect(handler(null)).toBeNull();
      });

      test('whenUndefinedInputThenReturnsUndefined', () => {
        const handler = getHandler({ actions: [{ type: 'delete', path: '$.x' }] });
        expect(handler(undefined)).toBeUndefined();
      });

      test('whenMissingPathThenNoError', () => {
        const handler = getHandler({
          actions: [{ type: 'delete', path: '$.nonexistent' }],
        });
        expect(handler({ name: 'Jane' })).toEqual({ name: 'Jane' });
      });

      test('whenMissingIntermediatePathSegmentThenNoError', () => {
        const handler = getHandler({
          actions: [{ type: 'delete', path: '$.a.b.c' }],
        });
        expect(handler({ a: { x: 1 } })).toEqual({ a: { x: 1 } });
      });

      test('whenNoActionsThenReturnsUnchanged', () => {
        const handler = getHandler({});
        expect(handler({ data: 'test' })).toEqual({ data: 'test' });
      });

      test('whenOriginalNotMutatedThenInputPreserved', () => {
        const handler = getHandler({
          actions: [{ type: 'delete', path: '$.ssn' }],
        });
        const original = { name: 'Jane', ssn: '123' };
        handler(original);
        expect(original.ssn).toBe('123');
      });

      test('whenUnknownActionTypeThenThrowsError', () => {
        const handler = getHandler({
          actions: [{ type: 'encrypt', path: '$.ssn' }],
        });
        expect(() => handler({ name: 'Jane', ssn: '123' }))
          .toThrow("Unknown action type: 'encrypt'");
      });

      test('whenReplaceWithoutReplacementThenThrowsError', () => {
        const handler = getHandler({
          actions: [{ type: 'replace', path: '$.ssn' }],
        });
        expect(() => handler({ ssn: '123' })).toThrow('does not specify a replacement');
      });

      test('whenActionMissingPathThenThrowsError', () => {
        const handler = getHandler({
          actions: [{ type: 'delete' }],
        });
        expect(() => handler({ ssn: '123' })).toThrow("does not declare 'path'");
      });

      test('whenActionMissingTypeThenThrowsError', () => {
        const handler = getHandler({
          actions: [{ path: '$.ssn' }],
        });
        expect(() => handler({ ssn: '123' })).toThrow("does not declare 'type'");
      });

      test('whenPathWithoutDollarPrefixThenStillWorks', () => {
        const handler = getHandler({
          actions: [{ type: 'delete', path: 'ssn' }],
        });
        expect(handler({ name: 'Jane', ssn: '123' }))
          .toEqual({ name: 'Jane' });
      });

      test('whenRecursiveDescentPathThenThrowsError', () => {
        const handler = getHandler({
          actions: [{ type: 'delete', path: '$..ssn' }],
        });
        expect(() => handler({ ssn: '123' })).toThrow('Unsupported JSONPath: recursive descent');
      });

      test('whenBracketNotationPathThenThrowsError', () => {
        const handler = getHandler({
          actions: [{ type: 'delete', path: '$.items[0]' }],
        });
        expect(() => handler({ items: ['a'] })).toThrow('Unsupported JSONPath: bracket notation');
      });

      test('whenWildcardPathThenThrowsError', () => {
        const handler = getHandler({
          actions: [{ type: 'delete', path: '$.store.*' }],
        });
        expect(() => handler({ store: { a: 1 } })).toThrow('Unsupported JSONPath: wildcard');
      });

      test('whenArrayWildcardPathThenThrowsError', () => {
        const handler = getHandler({
          actions: [{ type: 'blacken', path: '$.users[*].email' }],
        });
        expect(() => handler({ users: [{ email: 'a@b.com' }] })).toThrow('Unsupported JSONPath: bracket notation');
      });

      test('whenFilterExpressionPathThenThrowsError', () => {
        const handler = getHandler({
          actions: [{ type: 'delete', path: '$.books[?(@.price<10)]' }],
        });
        expect(() => handler({ books: [] })).toThrow('Unsupported JSONPath: bracket notation');
      });
    });
  });

  describe('predicateFromConditions', () => {
    test.each([
      { operator: '==', actual: 'a', expected: 'a', result: true },
      { operator: '==', actual: 'a', expected: 'b', result: false },
      { operator: '!=', actual: 'a', expected: 'b', result: true },
      { operator: '!=', actual: 'a', expected: 'a', result: false },
      { operator: '>=', actual: 10, expected: 5, result: true },
      { operator: '>=', actual: 5, expected: 5, result: true },
      { operator: '>=', actual: 3, expected: 5, result: false },
      { operator: '<=', actual: 3, expected: 5, result: true },
      { operator: '<=', actual: 5, expected: 5, result: true },
      { operator: '<=', actual: 10, expected: 5, result: false },
      { operator: '>', actual: 10, expected: 5, result: true },
      { operator: '>', actual: 5, expected: 5, result: false },
      { operator: '<', actual: 3, expected: 5, result: true },
      { operator: '<', actual: 5, expected: 5, result: false },
    ])('when$operator with actual=$actual expected=$expected thenReturns$result',
      ({ operator, actual, expected, result }) => {
        const predicate = predicateFromConditions({
          conditions: [{ path: '$.value', type: operator, value: expected }],
        });
        expect(predicate({ value: actual })).toBe(result);
      });

    test('whenRegexMatchThenReturnsTrue', () => {
      const predicate = predicateFromConditions({
        conditions: [{ path: '$.email', type: '=~', value: '^test@' }],
      });
      expect(predicate({ email: 'test@example.com' })).toBe(true);
      expect(predicate({ email: 'user@example.com' })).toBe(false);
    });

    test('whenRegexOnNonStringThenReturnsFalse', () => {
      const predicate = predicateFromConditions({
        conditions: [{ path: '$.age', type: '=~', value: '\\d+' }],
      });
      expect(predicate({ age: 25 })).toBe(false);
    });

    test('whenMultipleConditionsThenAndCombined', () => {
      const predicate = predicateFromConditions({
        conditions: [
          { path: '$.age', type: '>=', value: 18 },
          { path: '$.status', type: '==', value: 'active' },
        ],
      });
      expect(predicate({ age: 20, status: 'active' })).toBe(true);
      expect(predicate({ age: 16, status: 'active' })).toBe(false);
      expect(predicate({ age: 20, status: 'inactive' })).toBe(false);
    });

    test('whenNoConditionsThenAlwaysTrue', () => {
      expect(predicateFromConditions({})({ anything: 'value' })).toBe(true);
    });

    test('whenUnknownOperatorThenThrowsError', () => {
      const predicate = predicateFromConditions({
        conditions: [{ path: '$.x', type: '??', value: 1 }],
      });
      expect(() => predicate({ x: 1 })).toThrow("Not a valid predicate condition type: '??'");
    });
  });
});
