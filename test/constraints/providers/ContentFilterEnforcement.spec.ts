import { getHandler, predicateFromConditions } from '../../../lib/constraints/providers/ContentFilter';

// Spring source of truth: sapl-spring-boot-starter ContentFilter.java (branch 4.2.0).
// These scenarios pin the NestJS port to the same enforcement semantics: redaction
// either happens faithfully or the obligation fails closed (the handler throws, which
// the constraint plan turns into AccessDenied). Silent pass-through of sensitive data
// is never acceptable.

const BLACK_SQUARE = '█';

describe('ContentFilter enforcement parity with Spring PEP', () => {
  describe('predicate condition references a path absent from the element', () => {
    // CC-01: ContentFilter.java:223-229 wraps PathNotFoundException as AccessDenied.
    test('whenConditionPathAbsentThenFailsClosedInsteadOfEmittingCleartext', () => {
      const handler = getHandler({
        conditions: [{ path: '$.role', type: '==', value: 'admin' }],
        actions: [{ type: 'blacken', path: '$.ssn' }],
      });
      const elementWithoutRole = { ssn: '123-45-6789' };
      expect(() => handler(elementWithoutRole)).toThrow();
    });

    test('whenConditionPathAbsentThenPredicateFailsClosed', () => {
      const predicate = predicateFromConditions({
        conditions: [{ path: '$.role', type: '==', value: 'admin' }],
      });
      const elementWithoutRole = { ssn: '123-45-6789' };
      expect(() => predicate(elementWithoutRole)).toThrow();
    });
  });

  describe('redaction paths use full JSONPath expressions', () => {
    // CC-05: ContentFilter.java:333-359 evaluates Jayway JSONPath (indexing, wildcards,
    // recursive descent) against the native payload rather than simple dot paths.
    test('whenArrayIndexPathThenRedactsTheIndexedElementOnly', () => {
      const handler = getHandler({
        actions: [{ type: 'blacken', path: '$.items[0].ssn' }],
      });
      const result = handler({ items: [{ ssn: 'a', keep: 'k' }, { ssn: 'b' }] });
      expect(result.items[0].ssn).toBe(BLACK_SQUARE);
      expect(result.items[1].ssn).toBe('b');
    });

    test('whenWildcardPathThenRedactsEveryMatchingElement', () => {
      const handler = getHandler({
        actions: [{ type: 'blacken', path: '$.items[*].ssn' }],
      });
      const result = handler({ items: [{ ssn: 'a' }, { ssn: 'b' }] });
      expect(result.items.map((item: { ssn: string }) => item.ssn)).toEqual([BLACK_SQUARE, BLACK_SQUARE]);
    });

    test('whenRecursiveDescentPathThenRedactsEveryMatchAtAnyDepth', () => {
      const handler = getHandler({
        actions: [{ type: 'blacken', path: '$..ssn' }],
      });
      const result = handler({ patient: { ssn: 'a' }, guardian: { ssn: 'b' } });
      expect(result.patient.ssn).toBe(BLACK_SQUARE);
      expect(result.guardian.ssn).toBe(BLACK_SQUARE);
    });
  });

  describe('blacken output length exceeds the permitted maximum', () => {
    // CC-06: ContentFilter.java:419-452 caps blacken output at MAX_BLACKEN = 1,000,000
    // and throws ERROR_LENGTH_TOO_LARGE beyond it.
    test('whenBlackenLengthExceedsMaximumThenRejected', () => {
      const handler = getHandler({
        actions: [{ type: 'blacken', path: '$.x', replacement: '*', length: 2_000_000 }],
      });
      const element = { x: 'hi' };
      expect(() => handler(element)).toThrow();
    });
  });

  describe('protected payload is a Set of elements', () => {
    // CC-09: ContentFilter.java:125-135 filters Set payloads element-wise, each element
    // resolving the path against its own runtime class.
    test('whenPayloadIsSetThenRedactsEachMemberElementWise', () => {
      const handler = getHandler({
        actions: [{ type: 'blacken', path: '$.ssn' }],
      });
      const result = handler(
        new Set([
          { ssn: 'a', name: 'A' },
          { ssn: 'b', name: 'B' },
        ]),
      );
      expect(result).toBeInstanceOf(Set);
      const redactedSsns = [...(result as Set<{ ssn: string }>)].map((member) => member.ssn);
      expect(redactedSsns).toEqual([BLACK_SQUARE, BLACK_SQUARE]);
    });
  });
});
