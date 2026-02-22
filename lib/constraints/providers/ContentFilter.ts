const BLACK_SQUARE = '\u2588';

function getByPath(obj: any, segments: string[]): any {
  let current = obj;
  for (const segment of segments) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[segment];
  }
  return current;
}

function setByPath(obj: any, segments: string[], value: any): void {
  let current = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    if (current == null || typeof current !== 'object') return;
    current = current[segments[i]];
  }
  if (current != null && typeof current === 'object') {
    current[segments[segments.length - 1]] = value;
  }
}

function deleteByPath(obj: any, segments: string[]): void {
  let current = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    if (current == null || typeof current !== 'object') return;
    current = current[segments[i]];
  }
  if (current != null && typeof current === 'object') {
    delete current[segments[segments.length - 1]];
  }
}

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

function parsePath(path: string): string[] {
  validatePath(path);
  let normalized = path;
  if (normalized.startsWith('$.')) {
    normalized = normalized.substring(2);
  }
  return normalized.split('.');
}

function blacken(
  value: string,
  replacement: string,
  discloseLeft: number,
  discloseRight: number,
  length?: number,
): string {
  if (value.length === 0) return value;

  const left = Math.min(discloseLeft, value.length);
  const right = Math.min(discloseRight, Math.max(0, value.length - left));
  const maskedCount = value.length - left - right;

  if (maskedCount <= 0) return value;

  const finalLength = length !== undefined && length >= 0 ? length : maskedCount;

  const prefix = value.substring(0, left);
  const suffix = value.substring(value.length - right);
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

function applyAction(obj: any, action: any): void {
  if (action == null || typeof action !== 'object') {
    throw new Error('An action in actions is not an object.');
  }

  const path = requireTextual(action, 'path');
  const segments = parsePath(path);
  const actionType = requireTextual(action, 'type').trim().toLowerCase();

  switch (actionType) {
    case 'delete': {
      deleteByPath(obj, segments);
      break;
    }
    case 'replace': {
      if (!('replacement' in action)) {
        throw new Error('The action does not specify a replacement.');
      }
      setByPath(obj, segments, action.replacement);
      break;
    }
    case 'blacken': {
      const currentValue = getByPath(obj, segments);
      if (typeof currentValue !== 'string') {
        throw new Error('The node identified by the path is not a text node.');
      }
      const replacementChar = action.replacement ?? BLACK_SQUARE;
      if (typeof replacementChar !== 'string') {
        throw new Error("'replacement' of 'blacken' action is not textual.");
      }
      const discloseLeft = action.discloseLeft ?? 0;
      const discloseRight = action.discloseRight ?? 0;
      const blackenLength = action.length;
      if (blackenLength !== undefined && (typeof blackenLength !== 'number' || blackenLength < 0)) {
        throw new Error("'length' of 'blacken' action is not a valid non-negative number.");
      }
      const blackened = blacken(currentValue, replacementChar, discloseLeft, discloseRight, blackenLength);
      setByPath(obj, segments, blackened);
      break;
    }
    default:
      throw new Error(`Unknown action type: '${actionType}'.`);
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
      return typeof actual === 'string' && new RegExp(String(expected)).test(actual);
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

  return (value: any): any => {
    if (value == null) return value;

    const transform = (element: any): any => {
      if (element == null) return element;
      if (conditions.length > 0 && !meetsConditions(element, conditions)) {
        return element;
      }
      const copy = JSON.parse(JSON.stringify(element));
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
  return (element: any): boolean => meetsConditions(element, conditions);
}
