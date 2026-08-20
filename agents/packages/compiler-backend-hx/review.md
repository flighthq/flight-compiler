---
package: '@flighthq/compiler-backend-hx'
status: early
score: 30
updated: 2026-08-20
ingested:
  - source
  - agents/compiler-migration-roadmap.md
  - golden/
---

# compiler-backend-hx — Review

Haxe lowering, naming and source emission: ~1,180 lines across the emitter and the identity primitive. Haxe is the first integration target and defines the initial compatibility bar, so this package's readiness is the migration's readiness.

## Verdict

**early — 30/100.** The identity half is in good shape — package, module and target-name mapping are separated, tested directly, and consistent between what the emitter names a file and what an import refers to. The emission half handles a real but narrow slice: functions, classes, typedefs, enum abstracts, control flow, operators from a closed set. Everything else refuses, by name, which is the correct interim behaviour and is what makes the fixtures meaningful. The roadmap puts Haxe parity at 10–15%; I would score the _package_ a little higher than the parity number because its structure and refusal discipline are ahead of its coverage.

## What a fully expressed Haxe backend looks like

- **Idiomatic, compiling Haxe for the whole neutral IR** — every construct the IR can express is lowered, and nothing is approximated.
- **A Haxe type model, not a mapping table.** `Null<T>`, `Dynamic`, abstracts, typedefs, structural versus nominal typing, `Int` versus `Float`, and Haxe's own generics have semantics that a per-name table cannot capture. A reference version decides representation from the neutral type, not from a name lookup.
- **A declared binding for every external type the SDK uses** — `Array`, `Map`, `Set`, `String` methods, `Math`, typed arrays — where the backend elects either a direct native mapping (`Map` to `haxe.ds.Map`) or a route through the runtime contract, and neither is a passthrough.
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
- **Explicit external-type election.** A versioned table routes collections, tasks, and typed arrays through `flighthq._internal`, keeps exact native mappings explicit, and rejects every unknown reachable ambient type before target-name allocation. The runtime module prefix remains configurable without moving runtime implementation ownership into the compiler.
- **Control flow.** Blocks, if/else, while, do-while, for-in over `Reflect.fields`, for-of, switch, try/catch, break/continue, throw — with C-style `for`, switch fallthrough and `finally` refused rather than approximated.
- **Golden-pinned output.** Six fixtures pin emitted Haxe byte-for-byte and three pin refusals, so any change to lowering is a reviewable diff rather than an assertion about a substring.

## Gaps

- **Runtime value bindings remain incomplete.** Named external types are closed, but ambient constructors, static members, and standard-library calls still use value-emission rules rather than the versioned completeness plan.
- **No async lowering.** `await`, async functions, async methods, async closures and async iteration all refuse. The SDK is full of them.
- **No nullability lowering.** `undefined` in expression position refuses, and optional property/element/call access all refuse, because the neutral model has no narrowing facts to lower from.
- **Interfaces emit as typedefs, which cannot be `implements`ed.** A class whose IR carries an `implements` clause emits `class X implements Y` where `Y` is a structural typedef — not valid Haxe. Interface inheritance refuses, but the simple case emits.
- **No module facade for re-exports.** A barrel refuses; Haxe's own module and import semantics are not modelled.
- **No spread, no object spread, no computed properties, no generic function expressions.**
- **No `abstract` class representation**, no accessors, no static blocks.
- **Number representation is a single choice.** Every numeric maps to `Float`; Haxe's `Int` is never produced, so array indices and enum discriminants are Floats in emitted code.
- **No output verification.** Nothing checks that emitted Haxe parses. The golden fixtures pin _bytes_, not validity, so a fixture can happily pin invalid Haxe — which has already happened once, with `this_.step`. Compiling the output belongs downstream in `flight-hx`, but a parse-level check here would have caught it.
- **No byte-parity harness against `flight-hx`.** The acceptance criterion for this package is matching the existing generator, and there is no pinned old-versus-new comparison yet. The roadmap names it as the next milestone.
