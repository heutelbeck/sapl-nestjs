import safe from 'safe-regex2';

const BLACK_SQUARE = '█';
const MAX_BLACKEN = 1_000_000;

const DANGEROUS_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

type Selector =
  | { kind: 'child'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }
  | { kind: 'recursive'; name: string };

interface NodeRef {
  container: any;
  key: string | number;
}

function rejectDangerous(name: string, path: string): void {
  if (DANGEROUS_SEGMENTS.has(name)) {
    throw new Error(`Unsafe path segment '${name}' in '${path}'. Prototype-polluting paths are rejected.`);
  }
}

function parseBracket(path: string, start: number): { selector: Selector; next: number } {
  const close = path.indexOf(']', start);
  if (close === -1) {
    throw new Error(`Malformed JSONPath: unterminated bracket in '${path}'.`);
  }
  const content = path.slice(start + 1, close).trim();
  const next = close + 1;
  if (content === '*') {
    return { selector: { kind: 'wildcard' }, next };
  }
  if (/^-?\d+$/.test(content)) {
    return { selector: { kind: 'index', index: Number(content) }, next };
  }
  if ((content.startsWith("'") && content.endsWith("'")) || (content.startsWith('"') && content.endsWith('"'))) {
    const name = content.slice(1, -1);
    rejectDangerous(name, path);
    return { selector: { kind: 'child', name }, next };
  }
  if (content.startsWith('?')) {
    throw new Error(
      `Unsupported JSONPath: filter expression in '${path}'. Filter predicates are not yet implemented.`,
    );
  }
  throw new Error(`Unsupported JSONPath: bracket expression '[${content}]' in '${path}'.`);
}

function readName(path: string, start: number): { name: string; next: number } {
  let end = start;
  while (end < path.length && path[end] !== '.' && path[end] !== '[') {
    end++;
  }
  return { name: path.slice(start, end), next: end };
}

function parsePath(path: string): Selector[] {
  const selectors: Selector[] = [];
  let i = 0;
  if (path[i] === '$') i++;
  while (i < path.length) {
    const char = path[i];
    if (char === '[') {
      const { selector, next } = parseBracket(path, i);
      selectors.push(selector);
      i = next;
      continue;
    }
    if (char === '.') {
      if (path[i + 1] === '.') {
        i += 2;
        if (path[i] === '*' || path[i] === '[') {
          throw new Error(
            `Unsupported JSONPath: recursive descent must name a field in '${path}'.`,
          );
        }
        const { name, next } = readName(path, i);
        rejectDangerous(name, path);
        selectors.push({ kind: 'recursive', name });
        i = next;
        continue;
      }
      i++;
      if (path[i] === '*') {
        selectors.push({ kind: 'wildcard' });
        i++;
        continue;
      }
      const { name, next } = readName(path, i);
      rejectDangerous(name, path);
      selectors.push({ kind: 'child', name });
      i = next;
      continue;
    }
    const { name, next } = readName(path, i);
    rejectDangerous(name, path);
    selectors.push({ kind: 'child', name });
    i = next;
  }
  return selectors;
}

function isObject(value: any): boolean {
  return value != null && typeof value === 'object';
}

function collectRecursive(node: any, name: string, out: NodeRef[]): void {
  if (!isObject(node)) return;
  if (!Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, name)) {
    out.push({ container: node, key: name });
  }
  const children = Array.isArray(node) ? node : Object.values(node);
  for (const child of children) {
    collectRecursive(child, name, out);
  }
}

function expandSelector(value: any, selector: Selector, out: NodeRef[]): void {
  switch (selector.kind) {
    case 'child':
      if (isObject(value) && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, selector.name)) {
        out.push({ container: value, key: selector.name });
      }
      break;
    case 'index':
      if (Array.isArray(value) && selector.index >= 0 && selector.index < value.length) {
        out.push({ container: value, key: selector.index });
      }
      break;
    case 'wildcard':
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
          out.push({ container: value, key: index });
        }
      } else if (isObject(value)) {
        for (const key of Object.keys(value)) {
          if (!DANGEROUS_SEGMENTS.has(key)) out.push({ container: value, key });
        }
      }
      break;
    case 'recursive':
      collectRecursive(value, selector.name, out);
      break;
  }
}

function resolveRefs(root: any, selectors: Selector[]): NodeRef[] {
  const wrapper = [root];
  let current: NodeRef[] = [{ container: wrapper, key: 0 }];
  for (const selector of selectors) {
    const next: NodeRef[] = [];
    for (const ref of current) {
      expandSelector(ref.container[ref.key], selector, next);
    }
    current = next;
  }
  return current;
}

function refValue(ref: NodeRef): any {
  return ref.container[ref.key];
}

function deleteRef(ref: NodeRef): void {
  if (Array.isArray(ref.container) && typeof ref.key === 'number') {
    ref.container.splice(ref.key, 1);
  } else {
    delete ref.container[ref.key];
  }
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

  if (replacement.length * finalLength > MAX_BLACKEN) {
    throw new Error("'length' of 'blacken' action exceeds the maximum permitted blacken length.");
  }

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

function applyActionToRef(ref: NodeRef, action: any, actionType: string): void {
  switch (actionType) {
    case 'delete':
      deleteRef(ref);
      break;
    case 'replace':
      if (!('replacement' in action)) {
        throw new Error('The action does not specify a replacement.');
      }
      ref.container[ref.key] = action.replacement;
      break;
    case 'blacken': {
      const currentValue = refValue(ref);
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
      if (blackenLength !== undefined && blackenLength > MAX_BLACKEN) {
        throw new Error("'length' of 'blacken' action exceeds the maximum permitted blacken length.");
      }
      ref.container[ref.key] = blacken(currentValue, replacementChar, discloseLeft, discloseRight, blackenLength);
      break;
    }
    default:
      throw new Error(`Unknown action type: '${actionType}'.`);
  }
}

function applyAction(target: any, action: any): void {
  if (action == null || typeof action !== 'object') {
    throw new Error('An action in actions is not an object.');
  }

  const path = requireTextual(action, 'path');
  const selectors = parsePath(path);
  const actionType = requireTextual(action, 'type').trim().toLowerCase();

  for (const ref of resolveRefs(target, selectors)) {
    applyActionToRef(ref, action, actionType);
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

function readConditionValue(element: any, path: string): any {
  const refs = resolveRefs(element, parsePath(path));
  if (refs.length === 0) {
    // Fail closed: an unresolvable predicate path cannot be evaluated, so the
    // obligation must deny rather than silently skip redaction.
    throw new Error(`The path '${path}' defined in the constraint is not present in the data.`);
  }
  if (refs.length === 1) return refValue(refs[0]);
  return refs.map(refValue);
}

// Numeric conditions compare with native double semantics, which is exact for every
// value an IEEE-754 double can hold (all realistic identifiers and decimals). Values
// that need more precision (integers above 2^53, longer decimals) are already collapsed
// to doubles by JSON.parse before they reach here, so unlike the reference engine's
// exact-decimal comparison they compare as doubles. JavaScript cannot recover precision
// that was lost before the value became a number.
function evaluateCondition(element: any, condition: any): boolean {
  const actual = readConditionValue(element, condition.path ?? '');
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

    if (value instanceof Set) {
      return new Set([...value].map(transform));
    }
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
