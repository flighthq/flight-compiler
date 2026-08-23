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
  'array.filter': { borrowsElement: true, collect: true, kind: 'iterator', targetName: 'filter' },
  'array.length': { kind: 'countingMethod', targetName: 'len' },
  'array.map': { collect: true, kind: 'iterator', targetName: 'map' },
  'array.pop': { kind: 'method', targetName: 'pop' },
  'array.push': { kind: 'method', targetName: 'push' },
  'array.reverse': { kind: 'method', targetName: 'reverse' },
  'string.endsWith': { kind: 'borrowedMethod', targetName: 'ends_with' },
  // The source language replaces the first occurrence; Rust's `replace` replaces every one, and
  // `replacen` with a count of one is the member that means what the source meant.
  'string.replace': { kind: 'borrowedMethod', targetName: 'replacen', trailingArguments: ['1'] },
  'string.startsWith': { kind: 'borrowedMethod', targetName: 'starts_with' },
  'string.toLowerCase': { kind: 'method', targetName: 'to_lowercase' },
  'string.toUpperCase': { kind: 'method', targetName: 'to_uppercase' },
  'string.trim': { kind: 'method', owns: true, targetName: 'trim' },
  'tuple.length': { kind: 'countingMethod', targetName: 'len' },
};
