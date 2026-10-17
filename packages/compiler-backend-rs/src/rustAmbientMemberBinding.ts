import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerRustAmbientMemberBinding,
  CompilerRustAmbientMemberBindingPlan,
  IrResolvedMember,
  IrResolvedMemberReceiver,
} from '../../compiler-types/src/index.js';

// How Rust spells a member of the ambient surface.
//
// Rust reaches a collection's shape through iterators rather than through methods on the collection,
// so `map` is a chain that has to be collected back and `length` is a call that counts in `usize`.
// Those are shapes, not renames, which is why the binding says which shape rather than only a name.
// A member absent from this table has no agreed Rust spelling and is refused rather than guessed at.

export function createCompilerRustAmbientMemberBindingPlan(): CompilerRustAmbientMemberBindingPlan {
  return {
    bindings: Object.entries(rustAmbientMemberBindings)
      .sort(([left], [right]) => compareTextCodeUnits(left, right))
      .map(([identity, binding]) => {
        const separator = identity.indexOf('.');
        return {
          binding: structuredClone(binding),
          receiver: identity.slice(0, separator) as IrResolvedMemberReceiver,
          sourceMember: identity.slice(separator + 1),
        };
      }),
    schema: 'flight-rust-ambient-member-bindings/1',
  };
}

export function getCompilerRustAmbientMemberBinding(
  member: Readonly<IrResolvedMember>,
): CompilerRustAmbientMemberBinding | undefined {
  return rustAmbientMemberBindings[`${member.receiver}.${member.name}`];
}

const rustAmbientMemberBindings: Readonly<Record<string, CompilerRustAmbientMemberBinding>> = {
  'arrayBuffer.byteLength': { kind: 'countingMethod', targetName: 'byte_length' },
  'array.concat': { kind: 'method', targetName: 'extend' },
  'array.copyWithin': { kind: 'method', targetName: 'copy_within' },
  'array.every': { collect: false, kind: 'iterator', targetName: 'all' },
  'array.fill': { kind: 'method', targetName: 'fill' },
  'array.filter': { borrowsElement: true, collect: true, kind: 'iterator', targetName: 'filter' },
  'array.find': { borrowsElement: true, collect: false, kind: 'iterator', targetName: 'find' },
  'array.findIndex': { kind: 'predicatePosition', targetName: 'position' },
  'array.flatMap': { collect: true, kind: 'iterator', targetName: 'flat_map' },
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
  // `slice` is emitted as a range rather than bound to a name: Rust reaches a subrange through
  // indexing, and the source's optional bounds decide which range it is.
  'array.slice': { kind: 'method', targetName: 'slice' },
  'array.some': { collect: false, kind: 'iterator', targetName: 'any' },
  'array.sort': { kind: 'method', targetName: 'sort_by' },
  'array.unshift': { kind: 'method', leadingArguments: ['0'], targetName: 'insert' },
  'dataView.buffer': { kind: 'propertyMethod', targetName: 'buffer' },
  'dataView.byteLength': { kind: 'countingMethod', targetName: 'byte_length' },
  'dataView.byteOffset': { kind: 'countingMethod', targetName: 'byte_offset' },
  'dataView.getFloat32': { kind: 'method', targetName: 'get_float32' },
  'dataView.getFloat64': { kind: 'method', targetName: 'get_float64' },
  'dataView.getInt8': { kind: 'method', targetName: 'get_int8' },
  'dataView.getInt16': { kind: 'method', targetName: 'get_int16' },
  'dataView.getInt32': { kind: 'method', targetName: 'get_int32' },
  'dataView.getUint8': { kind: 'method', targetName: 'get_uint8' },
  'dataView.getUint16': { kind: 'method', targetName: 'get_uint16' },
  'dataView.getUint32': { kind: 'method', targetName: 'get_uint32' },
  'dataView.setFloat32': { kind: 'method', targetName: 'set_float32' },
  'dataView.setFloat64': { kind: 'method', targetName: 'set_float64' },
  'dataView.setInt8': { kind: 'method', targetName: 'set_int8' },
  'dataView.setInt16': { kind: 'method', targetName: 'set_int16' },
  'dataView.setInt32': { kind: 'method', targetName: 'set_int32' },
  'dataView.setUint8': { kind: 'method', targetName: 'set_uint8' },
  'dataView.setUint16': { kind: 'method', targetName: 'set_uint16' },
  'dataView.setUint32': { kind: 'method', targetName: 'set_uint32' },
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
  'map.clear': { kind: 'method', targetName: 'clear' },
  'map.delete': { kind: 'borrowedMethod', targetName: 'remove' },
  'map.get': { kind: 'optionalLookup', targetName: 'get' },
  'map.has': { kind: 'borrowedMethod', targetName: 'contains_key' },
  'map.set': { kind: 'method', targetName: 'insert' },
  'map.size': { kind: 'countingMethod', targetName: 'len' },
  'number.toString': { kind: 'method', targetName: 'to_string' },
  'set.add': { kind: 'method', targetName: 'insert' },
  'set.clear': { kind: 'method', targetName: 'clear' },
  'set.delete': { kind: 'borrowedMethod', targetName: 'remove' },
  'set.has': { kind: 'borrowedMethod', targetName: 'contains' },
  'set.size': { kind: 'countingMethod', targetName: 'len' },
  // A code unit is not a Unicode scalar: a surrogate half has no `char`, so `encode_utf16` is the
  // exact source sequence and the emitter reads the unit the source index selects.
  'string.charCodeAt': { kind: 'codeUnitQuery', targetName: 'encode_utf16' },
  'string.endsWith': { kind: 'borrowedMethod', targetName: 'ends_with' },
  'string.includes': { kind: 'borrowedMethod', targetName: 'contains' },
  'string.indexOf': { kind: 'sentinelSearch', targetName: 'find' },
  'string.lastIndexOf': { kind: 'sentinelSearch', targetName: 'rfind' },
  // `String::len` counts UTF-8 bytes; the source's length counts UTF-16 code units. Enumerating
  // `encode_utf16` is the exact code-unit sequence, so the emitter counts that instead.
  'string.length': { kind: 'codeUnitLength', targetName: 'encode_utf16' },
  // The source language replaces the first occurrence; Rust's `replace` replaces every one, and
  // `replacen` with a count of one is the member that means what the source meant.
  'string.replace': { kind: 'borrowedMethod', targetName: 'replacen', trailingArguments: ['1'] },
  'string.repeat': { kind: 'runtimeMethod', targetName: 'repeat_text' },
  'string.split': { kind: 'splitCollect', targetName: 'split' },
  'string.startsWith': { kind: 'borrowedMethod', targetName: 'starts_with' },
  'string.toLowerCase': { kind: 'method', targetName: 'to_lowercase' },
  'string.toUpperCase': { kind: 'method', targetName: 'to_uppercase' },
  'string.trim': { kind: 'method', owns: true, targetName: 'trim' },
  'typedArray.buffer': { kind: 'propertyMethod', targetName: 'buffer' },
  'typedArray.byteLength': { kind: 'countingMethod', targetName: 'byte_length' },
  'typedArray.byteOffset': { kind: 'countingMethod', targetName: 'byte_offset' },
  'typedArray.length': { kind: 'countingMethod', targetName: 'len' },
  'typedArray.slice': { kind: 'method', targetName: 'slice' },
  'typedArray.subarray': { kind: 'method', targetName: 'subarray' },
  'tuple.length': { kind: 'countingMethod', targetName: 'len' },
};
