import type { CompilerCppAmbientMemberBinding, IrResolvedMember } from '../../compiler-types/src/index.js';

export function getCompilerCppAmbientMemberBinding(
  member: Readonly<IrResolvedMember>,
): CompilerCppAmbientMemberBinding | undefined {
  return cppAmbientMemberBindings[`${member.receiver}.${member.name}`];
}

const cppAmbientMemberBindings: Readonly<Record<string, CompilerCppAmbientMemberBinding>> = {
  'array.concat': { kind: 'method', targetName: 'insert' },
  'array.filter': { algorithm: 'std::copy_if', kind: 'algorithm', targetName: 'copy_if' },
  'array.includes': { kind: 'method', targetName: 'contains' },
  'array.indexOf': { algorithm: 'std::find', kind: 'algorithm', targetName: 'find' },
  'array.join': { kind: 'method', targetName: 'join' },
  'array.length': { kind: 'sizeMethod', targetName: 'size' },
  'array.map': { algorithm: 'std::transform', kind: 'algorithm', targetName: 'transform' },
  'array.pop': { kind: 'method', targetName: 'pop_back' },
  'array.push': { kind: 'method', targetName: 'push_back' },
  'array.reverse': { kind: 'method', targetName: 'reverse' },
  'array.some': { algorithm: 'std::any_of', kind: 'algorithm', targetName: 'any_of' },
  'array.every': { algorithm: 'std::all_of', kind: 'algorithm', targetName: 'all_of' },
  'array.find': { algorithm: 'std::find_if', kind: 'algorithm', targetName: 'find_if' },
  'array.reduce': { algorithm: 'std::accumulate', kind: 'algorithm', targetName: 'accumulate' },
  'map.delete': { kind: 'method', targetName: 'erase' },
  'map.get': { kind: 'method', targetName: 'at' },
  'map.has': { kind: 'method', targetName: 'count' },
  'map.set': { kind: 'method', targetName: 'insert_or_assign' },
  'map.size': { kind: 'sizeMethod', targetName: 'size' },
  'number.toString': { kind: 'method', targetName: 'to_string' },
  'set.add': { kind: 'method', targetName: 'insert' },
  'set.delete': { kind: 'method', targetName: 'erase' },
  'set.has': { kind: 'method', targetName: 'count' },
  'set.size': { kind: 'sizeMethod', targetName: 'size' },
  'string.endsWith': { kind: 'method', targetName: 'ends_with' },
  'string.includes': { kind: 'method', targetName: 'contains' },
  'string.indexOf': { kind: 'method', targetName: 'find' },
  'string.length': { kind: 'sizeMethod', targetName: 'size' },
  'string.replace': { kind: 'method', targetName: 'replace' },
  'string.split': { kind: 'method', targetName: 'split' },
  'string.startsWith': { kind: 'method', targetName: 'starts_with' },
  'string.toLowerCase': { kind: 'method', targetName: 'to_lower' },
  'string.toUpperCase': { kind: 'method', targetName: 'to_upper' },
  'string.trim': { kind: 'method', targetName: 'trim' },
};
