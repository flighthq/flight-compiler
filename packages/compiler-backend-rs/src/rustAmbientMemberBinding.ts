import type { CompilerRustAmbientMemberBinding, IrResolvedMember } from '../../compiler-types/src/index.js';

// How Rust spells a member of the ambient surface.
//
// Rust reaches a collection's shape through iterators rather than through methods on the collection,
// so `map` is a chain that has to be collected back and `length` is a call that counts in `usize`.
// Those are shapes, not renames, which is why the binding says which shape rather than only a name.
// A member absent from this table has no agreed Rust spelling and is refused rather than guessed at.

export function getCompilerRustAmbientMemberBinding(
  member: Readonly<IrResolvedMember>,
): CompilerRustAmbientMemberBinding | undefined {
  return rustAmbientMemberBindings[`${member.receiver}.${member.name}`];
}

const rustAmbientMemberBindings: Readonly<Record<string, CompilerRustAmbientMemberBinding>> = {
  'array.concat': { kind: 'method', targetName: 'extend' },
  'array.every': { collect: false, kind: 'iterator', targetName: 'all' },
  'array.filter': { borrowsElement: true, collect: true, kind: 'iterator', targetName: 'filter' },
  'array.find': { borrowsElement: true, collect: false, kind: 'iterator', targetName: 'find' },
  'array.includes': { kind: 'borrowedMethod', targetName: 'contains' },
  'array.indexOf': { kind: 'positionSearch', targetName: 'position' },
  'array.join': { kind: 'borrowedMethod', targetName: 'join' },
  'array.lastIndexOf': { kind: 'positionSearch', targetName: 'rposition' },
  'array.length': { kind: 'countingMethod', targetName: 'len' },
  'array.map': { collect: true, kind: 'iterator', targetName: 'map' },
  'array.pop': { kind: 'method', targetName: 'pop' },
  'array.push': { kind: 'method', targetName: 'push' },
  'array.reduce': { argumentOrder: [1, 0], collect: false, kind: 'iterator', targetName: 'fold' },
  'array.reverse': { kind: 'method', targetName: 'reverse' },
  'array.shift': { kind: 'method', leadingArguments: ['0'], targetName: 'remove' },
  // `slice` is emitted as a range rather than bound to a name: Rust reaches a subrange through
  // indexing, and the source's optional bounds decide which range it is.
  'array.slice': { kind: 'method', targetName: 'slice' },
  'array.some': { collect: false, kind: 'iterator', targetName: 'any' },
  'array.unshift': { kind: 'method', leadingArguments: ['0'], targetName: 'insert' },
  'date.getDate': { kind: 'method', targetName: 'day' },
  'date.getDay': { kind: 'method', targetName: 'weekday' },
  'date.getFullYear': { kind: 'method', targetName: 'year' },
  'date.getHours': { kind: 'method', targetName: 'hour' },
  'date.getMilliseconds': { kind: 'method', targetName: 'millisecond' },
  'date.getMinutes': { kind: 'method', targetName: 'minute' },
  'date.getMonth': { kind: 'method', targetName: 'month' },
  'date.getSeconds': { kind: 'method', targetName: 'second' },
  'date.getTime': { kind: 'method', targetName: 'timestamp_millis' },
  'date.toISOString': { kind: 'method', targetName: 'to_iso_string' },
  'date.toString': { kind: 'method', targetName: 'to_string' },
  'error.message': { kind: 'method', targetName: 'to_string' },
  'map.delete': { kind: 'borrowedMethod', targetName: 'remove' },
  'map.get': { kind: 'optionalLookup', targetName: 'get' },
  'map.has': { kind: 'borrowedMethod', targetName: 'contains_key' },
  'map.set': { kind: 'method', targetName: 'insert' },
  'map.size': { kind: 'countingMethod', targetName: 'len' },
  'number.toString': { kind: 'method', targetName: 'to_string' },
  'set.add': { kind: 'method', targetName: 'insert' },
  'set.delete': { kind: 'borrowedMethod', targetName: 'remove' },
  'set.has': { kind: 'borrowedMethod', targetName: 'contains' },
  'set.size': { kind: 'countingMethod', targetName: 'len' },
  'string.length': { kind: 'countingMethod', targetName: 'len' },
  'string.endsWith': { kind: 'borrowedMethod', targetName: 'ends_with' },
  'string.includes': { kind: 'borrowedMethod', targetName: 'contains' },
  'string.indexOf': { kind: 'sentinelSearch', targetName: 'find' },
  'string.lastIndexOf': { kind: 'sentinelSearch', targetName: 'rfind' },
  // The source language replaces the first occurrence; Rust's `replace` replaces every one, and
  // `replacen` with a count of one is the member that means what the source meant.
  'string.replace': { kind: 'borrowedMethod', targetName: 'replacen', trailingArguments: ['1'] },
  'string.split': { kind: 'splitCollect', targetName: 'split' },
  'string.startsWith': { kind: 'borrowedMethod', targetName: 'starts_with' },
  'string.toLowerCase': { kind: 'method', targetName: 'to_lowercase' },
  'string.toUpperCase': { kind: 'method', targetName: 'to_uppercase' },
  'string.trim': { kind: 'method', owns: true, targetName: 'trim' },
  'typedArray.length': { kind: 'countingMethod', targetName: 'len' },
  'typedArray.slice': { kind: 'method', targetName: 'slice' },
  'tuple.length': { kind: 'countingMethod', targetName: 'len' },
};
