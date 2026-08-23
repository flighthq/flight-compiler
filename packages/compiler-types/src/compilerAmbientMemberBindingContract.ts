// How each target spells a member of the ambient surface.
//
// A rename is the common case. A member the target puts somewhere else entirely, or reaches through
// a different shape, is not a rename — Haxe's `trim` is a `StringTools` function and Rust's `map` is
// an iterator chain that has to be collected back — so the binding says which shape it is.
//
// A member absent from a target's table is refused at emission rather than guessed at, because a
// name that happens to exist on the target is the most expensive kind of coincidence.

export type CompilerHaxeAmbientMemberBinding =
  | Readonly<{ kind: 'property'; targetName: string }>
  | Readonly<{ kind: 'method'; targetName: string }>
  | Readonly<{ kind: 'staticCall'; targetPath: string }>;

export type CompilerRustAmbientMemberBinding =
  // `owns` marks a member whose result is borrowed from the receiver where the source's is a value of
  // its own: `trim` hands back a slice, and the source's `string` is owned.
  | Readonly<{ kind: 'method'; owns?: boolean; targetName: string }>
  | Readonly<{ kind: 'borrowedMethod'; owns?: boolean; targetName: string; trailingArguments?: readonly string[] }>
  | Readonly<{ kind: 'countingMethod'; targetName: string }>
  // `borrowsElement` marks an iterator adaptor that hands its closure a reference rather than the
  // element: `map` gives `T` and `filter` gives `&T`, and the closure has to be written for what it
  // is given.
  | Readonly<{ borrowsElement?: boolean; collect: boolean; kind: 'iterator'; targetName: string }>;
