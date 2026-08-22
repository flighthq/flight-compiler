---
package: '@flighthq/compiler-backend-hx'
status: early
score: 38
updated: 2026-08-21
ingested:
  - source
  - agents/compiler-migration-roadmap.md
  - golden/
---

# compiler-backend-hx — Review

Haxe lowering, naming and source emission: ~1,270 lines across the emitter, the identity primitive and the ambient-symbol binding table. 71 tests. Haxe is the first integration target and defines the initial compatibility bar, so this package's readiness is the migration's readiness.

## Verdict

**early — 38/100.** Up six points on the destructuring, tuple and control-flow batches: binding patterns now arrive pre-lowered from the neutral pass library, fixed tuples project and spread, computed access routes through `Reflect`, object rest emits, and nullish coalescing lowers to `??`. Two shapes that previously emitted _wrong_ Haxe now refuse instead — a class with an `implements` clause, and a labeled `break`/`continue` — which is the single most valuable kind of change this package can make, because an emitted-invalid case is worse than an unemitted one. The identity half remains in good shape. The score stays in the thirties because the domain's largest cells are untouched: async, nullability beyond `??`, a real number model, and module facades.

## What a fully expressed Haxe backend looks like

- **Idiomatic, compiling Haxe for the whole neutral IR** — every construct the IR can express is lowered, and nothing is approximated.
- **A Haxe type model, not a mapping table.** `Null<T>`, `Dynamic`, abstracts, typedefs, structural versus nominal typing, `Int` versus `Float`, and Haxe's own generics have semantics that a per-name table cannot capture. A reference version decides representation from the neutral type, not from a name lookup.
- **A declared binding for every ambient symbol the SDK uses** — type and value-space `Array`, `Map`, `Set`, `Math`, tasks and typed arrays — where the backend elects either a direct native mapping or a route through the runtime contract, and neither is a passthrough.
- **Async lowering.** Haxe has no `await`; a target needs a chosen strategy (continuations, a task type, or the runtime contract's own primitive) and a lowering into it.
- **Nullability lowering** driven by the neutral narrowing facts, producing `Null<T>` and null checks that match the source's intent.
- **Module and package layout matching Haxe's rules**, including one primary type per module, private types, and cross-package imports that resolve.
- **A runtime contract**: the small set of symbols emitted code may reference, versioned, with the downstream `flight-hx` implementation as its counterpart.
- **Byte-stable output** matching the existing `flight-hx` generator for the same input, which is the actual acceptance criterion for this package.
- **Emission-time verification** that the output at least parses as Haxe.

## Present capabilities

- **Identity is separated and direct-tested.** `haxeCompilerIdentity.ts` owns npm-package-to-Haxe-package mapping, source-path-to-module mapping and the internal-module fallback. One function decides module identity for both the emitted file path and the import that refers to it — an earlier version had two, and emitted `import flighthq.math._Index` for a file it wrote as `Index.hx`.
- **Target-name allocation consumed properly.** Declarations, imports, type parameters and type references all take their spelling from the shared allocator, and `this` emits as `this` rather than being mangled by the keyword filter — a defect the golden fixtures caught.
- **Closed operator handling.** Binary, assignment and unary operators come from the IR's closed vocabularies through exhaustive records, with `===`/`!==` mapped and everything unmapped refused. Unmapped operators used to pass through verbatim, producing `**` in Haxe files.
- **Enum abstracts with inferred backing.** Numeric enums emit `enum abstract T(Int) from Int to Int`, string enums infer `(String)`, mixed enums refuse, and non-finite values refuse.
- **Structural typedefs for interfaces and type aliases**, anonymous structures for object types, and `Null<T>` for optional-plus-null unions.
- **Explicit ambient-symbol election.** A versioned table independently routes type and value-space collections, tasks, typed arrays, and native values. Constructors and static members use the elected `flighthq._internal` target, while every unknown ambient symbol refuses before target-name allocation. The runtime module prefix remains configurable without moving runtime implementation ownership into the compiler.
- **Control flow.** Blocks, if/else, while, do-while, for-in over `Reflect.fields`, for-of, switch, try/catch, break/continue, throw — with C-style `for`, switch fallthrough and `finally` refused rather than approximated.
- **Destructuring arrives lowered, not handled.** The emitter refuses any residual binding pattern with "requires destructuring lowering before Haxe emission", so the neutral `array-binding-pattern` pass owns the shape and the backend owns only the result. The same boundary now holds for switch fallthrough.
- **Fixed tuples project and spread.** A statically known index emits `name[i]`, a rest emits `.slice(n)`, and a tuple spread builds its elements in an immediately-invoked function so evaluation order is preserved. A non-static index refuses.
- **Computed and optional access.** Computed object access emits `Reflect.field`, for-in iterates a key plan or `Reflect.fields`, and object rest binds its source once before excluding keys. Optional computed access refuses rather than approximating null-safety.
- **Labeled control flow refuses by name.** `break outer`, `continue outer` and a labeled statement each refuse with "requires Haxe completion-state lowering". Labels are now first-class in the neutral IR, so this is an explicit unmet case rather than the silent label drop that existed before.
- **Golden-pinned output.** Six fixtures pin emitted Haxe byte-for-byte and three pin refusals, so any change to lowering is a reviewable diff rather than an assertion about a substring.

## Gaps

- **No async lowering.** `await`, async functions, async methods, async closures and async iteration all refuse. The SDK is full of them.
- **Nullability is one operator deep.** `??` lowers now, but `undefined` in expression position still refuses and optional computed access refuses, because the neutral model still carries no narrowing facts to lower from.
- **Interfaces emit as typedefs, and nominal implementation is unmodelled.** A class carrying an `implements` clause now refuses with "requires nominal Haxe lowering" instead of emitting `class X implements Y` against a structural typedef, which was invalid Haxe. The refusal is correct; what is still missing is the Haxe interface representation that would let it emit.
- **No module facade for re-exports.** A barrel refuses; Haxe's own module and import semantics are not modelled.
- **No object spread, no computed properties, no generic function expressions.** Fixed-tuple spread emits; the general spread does not.
- **No `abstract` class representation**, no accessors, no static blocks.
- **Number representation is a single choice.** Every numeric maps to `Float`; Haxe's `Int` is never produced, so array indices and enum discriminants are Floats in emitted code.
- **No output verification.** Nothing checks that emitted Haxe parses. The golden fixtures pin _bytes_, not validity, so a fixture can happily pin invalid Haxe — which has already happened once, with `this_.step`. Compiling the output belongs downstream in `flight-hx`, but a parse-level check here would have caught it.
- **No byte-parity harness against `flight-hx`.** The acceptance criterion for this package is matching the existing generator, and there is no pinned old-versus-new comparison yet. The roadmap names it as the next milestone.

## Emitted-source claims this repository cannot check, recorded 2026-08-22

Three defects in emitted Haxe were found by reading output rather than by any gate, because the golden fixtures pin bytes and no Haxe compiler runs here. Two are fixed; the third is a claim I could not settle, and it is exactly what the parser-adapter seam in `compiler-emission` exists to settle.

- **Fixed: a computed array index emitted as `Float`.** Haxe indexes with `Int`, and the neutral numeric domain has only `number`, so `values[index]` did not compile. Indices are narrowed with `Std.int` now, and an integer literal is left alone.
- **Fixed elsewhere: `x === undefined` had no lowering.** It is `x == null` where the operand admits only one absent value, and a refusal where it admits both.
- **Unsettled: `values?.[index]`.** The emitter produces Haxe's safe-navigation operator in array position and a test pins it. Haxe's `?.` is documented for field access; whether it also reaches array access is a question about another language's grammar that nothing in this repository can answer. Emitting it is either correct or it is source that cannot parse, and the only thing that can decide is a real Haxe parser through the conformance adapter. Recorded rather than changed, because flipping committed behaviour on an unverified belief about a grammar is the worse error.
