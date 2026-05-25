import safe from 'safe-regex2';

const BLACK_SQUARE = '\u2588';

function getByPath(root: any, segments: string[]): any {
  let cursor = root;
  for (const segment of segments) {
    if (DANGEROUS_SEGMENTS.has(segment)) return undefined;
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function setByPath(root: any, segments: string[], value: any): void {
  let cursor = root;
  for (let depth = 0; depth < segments.length - 1; depth++) {
    if (DANGEROUS_SEGMENTS.has(segments[depth])) return;
    if (cursor == null || typeof cursor !== 'object') return;
    cursor = cursor[segments[depth]];
  }
  const leaf = segments[segments.length - 1];
  if (DANGEROUS_SEGMENTS.has(leaf)) return;
  if (cursor != null && typeof cursor === 'object') {
    cursor[leaf] = value;
  }
}

function deleteByPath(root: any, segments: string[]): void {
  let cursor = root;
  for (let depth = 0; depth < segments.length - 1; depth++) {
    if (DANGEROUS_SEGMENTS.has(segments[depth])) return;
    if (cursor == null || typeof cursor !== 'object') return;
    cursor = cursor[segments[depth]];
  }
  const leaf = segments[segments.length - 1];
  if (DANGEROUS_SEGMENTS.has(leaf)) return;
  if (cursor != null && typeof cursor === 'object') {
    delete cursor[leaf];
  }
}

const DANGEROUS_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function validatePath(path: string): void {
  if (path.includes('..')) {
    throw new Error(
      `Unsupported JSONPath: recursive descent ('..') in '${path}'. Only simple dot paths are supported (e.g., '$.field.nested').`,
    );
  }
  if (path.includes('[')) {
    throw new Error(
      `Unsupported JSONPath: bracket notation in '${path}'. Only simple dot paths are supported (e.g., '$.field.nested').`,
    );
  }
  if (path.includes('*')) {
    throw new Error(
      `Unsupported JSONPath: wildcard ('*') in '${path}'. Only simple dot paths are supported (e.g., '$.field.nested').`,
    );
  }
}

function validateSegments(segments: string[], path: string): void {
  for (const segment of segments) {
    if (DANGEROUS_SEGMENTS.has(segment)) {
      throw new Error(
        `Unsafe path segment '${segment}' in '${path}'. Prototype-polluting paths are rejected.`,
      );
    }
  }
}

function parsePath(path: string): string[] {
  validatePath(path);
  let normalized = path;
  if (normalized === '$') return [];
  if (normalized.startsWith('$.')) {
    normalized = normalized.substring(2);
  }
  const segments = normalized.split('.');
  validateSegments(segments, path);
  return segments;
}

function blacken(
  value: string,
  replacement: string,
  discloseLeft: number,
  discloseRight: number,
  length?: number,
): string {
  const chars = [...value];
  if (chars.length === 0) return value;

  const left = Math.min(discloseLeft, chars.length);
  const right = Math.min(discloseRight, Math.max(0, chars.length - left));
  const maskedCount = chars.length - left - right;

  if (maskedCount <= 0) return value;

  const finalLength = length !== undefined && length >= 0 ? length : maskedCount;

  const prefix = chars.slice(0, left).join('');
  const suffix = chars.slice(chars.length - right).join('');
  const masked = replacement.repeat(finalLength);
  return prefix + masked + suffix;
}

function requireTextual(action: any, key: string): string {
  if (action[key] == null) {
    throw new Error(`An action does not declare '${key}'.`);
  }
  if (typeof action[key] !== 'string') {
    throw new Error(`An action's '${key}' is not textual.`);
  }
  return action[key];
}

function applyAction(target: any, action: any): void {
  if (action == null || typeof action !== 'object') {
    throw new Error('An action in actions is not an object.');
  }

  const path = requireTextual(action, 'path');
  const segments = parsePath(path);
  const actionType = requireTextual(action, 'type').trim().toLowerCase();

  switch (actionType) {
    case 'delete': {
      deleteByPath(target, segments);
      break;
    }
    case 'replace': {
      if (!('replacement' in action)) {
        throw new Error('The action does not specify a replacement.');
      }
      setByPath(target, segments, action.replacement);
      break;
    }
    case 'blacken': {
      const currentValue = getByPath(target, segments);
      if (typeof currentValue !== 'string') {
        throw new Error('The node identified by the path is not a text node.');
      }
      const replacementChar = action.replacement ?? BLACK_SQUARE;
      if (typeof replacementChar !== 'string') {
        throw new Error("'replacement' of 'blacken' action is not textual.");
      }
      const discloseLeft = action.discloseLeft ?? 0;
      const discloseRight = action.discloseRight ?? 0;
      if (typeof discloseLeft !== 'number' || typeof discloseRight !== 'number') {
        throw new Error("'discloseLeft' and 'discloseRight' of 'blacken' action must be numbers.");
      }
      const blackenLength = action.length;
      if (blackenLength !== undefined && (typeof blackenLength !== 'number' || blackenLength < 0)) {
        throw new Error("'length' of 'blacken' action is not a valid non-negative number.");
      }
      const blackened = blacken(currentValue, replacementChar, discloseLeft, discloseRight, blackenLength);
      setByPath(target, segments, blackened);
      break;
    }
    default:
      throw new Error(`Unknown action type: '${actionType}'.`);
  }
}

const compiledRegexCache = new Map<string, RegExp>();

function precompileConditions(conditions: any[]): void {
  for (const condition of conditions) {
    if (condition.type === '=~') {
      const pattern = String(condition.value);
      if (!compiledRegexCache.has(pattern)) {
        if (!safe(pattern)) {
          throw new Error(`Unsafe regex pattern rejected (potential ReDoS): '${pattern}'.`);
        }
        compiledRegexCache.set(pattern, new RegExp(pattern));
      }
    }
  }
}

function evaluateCondition(element: any, condition: any): boolean {
  const segments = parsePath(condition.path ?? '');
  const actual = getByPath(element, segments);
  const expected = condition.value;
  const operator: string = condition.type;

  switch (operator) {
    case '==':
      return actual === expected;
    case '!=':
      return actual !== expected;
    case '>=':
      return actual >= expected;
    case '<=':
      return actual <= expected;
    case '>':
      return actual > expected;
    case '<':
      return actual < expected;
    case '=~':
      return typeof actual === 'string' && compiledRegexCache.get(String(condition.value))!.test(actual);
    default:
      throw new Error(`Not a valid predicate condition type: '${operator}'.`);
  }
}

function meetsConditions(element: any, conditions: any[]): boolean {
  return conditions.every((condition) => evaluateCondition(element, condition));
}

export function getHandler(constraint: any): (value: any) => any {
  const actions: any[] = constraint.actions ?? [];
  const conditions: any[] = constraint.conditions ?? [];
  precompileConditions(conditions);

  return (value: any): any => {
    if (value == null) return value;

    const transform = (element: any): any => {
      if (element == null) return element;
      if (conditions.length > 0 && !meetsConditions(element, conditions)) {
        return element;
      }
      const copy = structuredClone(element);
      for (const action of actions) {
        applyAction(copy, action);
      }
      return copy;
    };

    if (Array.isArray(value)) {
      return value.map(transform);
    }
    return transform(value);
  };
}

export function predicateFromConditions(constraint: any): (element: any) => boolean {
  const conditions: any[] = constraint.conditions ?? [];
  precompileConditions(conditions);
  return (element: any): boolean => meetsConditions(element, conditions);
}
