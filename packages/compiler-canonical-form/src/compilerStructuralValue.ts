import { compareTextCodeUnits } from './compilerTextOrder.js';

export function normalizeCompilerStructuralValueCanonical(value: unknown): string {
  return normalizeCompilerStructuralValueCanonicalInternal(value, new Set());
}

function normalizeCompilerStructuralValueCanonicalInternal(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean') return `boolean:${String(value)}`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical structural values require finite numbers');
    return `number:${Object.is(value, -0) ? '-0' : String(value)}`;
  }
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
  if (typeof value !== 'object') {
    throw new TypeError(`canonical structural values do not support ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError('canonical structural values cannot contain cycles');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        Reflect.ownKeys(value).length !== value.length + 1 ||
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index)) ||
        keys.some((key) => !isCompilerStructuralDataProperty(value, key))
      ) {
        throw new TypeError('canonical structural arrays must be dense data values without named properties');
      }
      return `array:[${value
        .map((item) => normalizeCompilerStructuralValueCanonicalInternal(item, ancestors))
        .join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonical structural values require plain objects');
    }
    const record = value as Readonly<Record<string, unknown>>;
    const ownKeys = Reflect.ownKeys(record);
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      throw new TypeError('canonical structural records do not support symbol keys');
    }
    const keys = (ownKeys as string[]).sort(compareTextCodeUnits);
    if (keys.some((key) => !isCompilerStructuralDataProperty(record, key))) {
      throw new TypeError('canonical structural records require enumerable data properties');
    }
    return `object:{${keys
      .map(
        (key) => `${JSON.stringify(key)}=${normalizeCompilerStructuralValueCanonicalInternal(record[key], ancestors)}`,
      )
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function isCompilerStructuralDataProperty(value: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable === true && 'value' in descriptor;
}
