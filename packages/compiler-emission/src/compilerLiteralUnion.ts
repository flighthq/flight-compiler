import type { IrType } from '../../compiler-types/src/index.js';

// The string values a union of string literals is closed over.
//
// The source language spells a closed set of names as `'a' | 'b'`, and both targets have a way to
// say that — Haxe's `enum abstract` over `String`, Rust's unit-variant enum. Recognising the shape is
// the same question for both, so it is asked once here rather than twice.
//
// Answered only when every member is a string literal: a union that mixes a literal with anything
// else is not a closed set of names, and describing it as one would be wrong rather than imprecise.
export function getIrUnionTypeStringLiteralValues(type: Readonly<IrType>): readonly string[] | undefined {
  if (type.kind !== 'union' || type.types.length < 2) return undefined;
  const values: string[] = [];
  for (const member of type.types) {
    if (member.kind !== 'literal' || typeof member.value !== 'string') return undefined;
    values.push(member.value);
  }
  return new Set(values).size === values.length ? values : undefined;
}
