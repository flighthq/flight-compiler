---
package: '@flighthq/compiler-lowering'
status: solid
score: 64
updated: 2026-08-21
ingested:
  - source
  - agents/compiler-breadth.md
  - golden/
---

# compiler-lowering — Review

The backend-elected library for pure target-neutral IR-to-IR transforms. It is no longer a lifecycle with one example in it: ~5,900 lines across four elected passes, two of them composites, plus a definite-assignment analysis and two shared completion primitives. 130 tests.

## Verdict

**solid — 64/100.** The framework is settled and the second wave of transforms landed: binding patterns (array and object, recursively), function-scoped variable hoisting with a real definite-assignment analysis, switch fallthrough, and C-style `for`. Each pass declares idempotence, verifies its own postcondition as an independent residual check rather than by re-running itself, and refuses by name with a stable code. What holds the score at 64 is that every transform so far is a _statement-shape_ transform. The expression side of the domain — call sites, spread, optional access, structural copy, async suspension — is entirely absent, and each of those is named by a refusal a golden fixture already pins.

## What a fully expressed lowering library looks like

- Plain `IrModule`-to-`IrModule` pass records with stable identity and dependency order. Present.
- Backend election, so a target keeps native semantics when lowering would make its output less idiomatic. Present as a mechanism; see the gap below — both backends currently elect the same four passes in the same order, so nothing exercises divergence.
- Structural and pass-specific verification after every transform, with declared idempotence available as an explicit audit. Present.
- Stable pass-named failures for malformed input, unsupported semantics, invalid order, execution failure, and false idempotence claims. Present; 33 distinct `unsupported-ir` refusals across the passes.
- One focused, target-neutral source and matching direct test per transform. Present.
- Control-flow transforms that preserve completion behavior across `break`, `continue`, `return`, `throw`, nested loops, switches, and `finally`. Substantially present for `continue` ownership, switch completion and hoisted initialization; `finally` still refuses and labeled targets are refused by both backends rather than lowered here.
- Expression and call-site transforms that preserve evaluation order, receiver identity, aliasing, and value-versus-discarded context. **Absent.** This is the missing half of the domain.
- No filesystem, TypeScript checker, target syntax, runtime implementation, or mandatory orchestration stage. Present.

## Present capabilities

- **Four elected passes, dependency-ordered.** `array-binding-pattern` (the composite), `variable-hoisting` (runs after it), `c-style-for`, and `switch-fallthrough` (runs after hoisting). Both backends run the same plan through `lowerIrModuleWithCompilerPasses`.
- **Postconditions are independent residual checks now.** Each `verifyIrModule` asks whether the construct it removes is still present — `hasIrModuleSwitchFallthrough`, `hasIrModuleCStyleForStatement`, `hasIrModuleVariableHoistingResidual` — rather than re-running the transform and comparing. The earlier "the verifier is the transform" shape is gone, and with it the doubled traversal cost: an ordinary pass now costs one lowering, one validating walk, and one residual walk.
- **Structural validation is a real validator.** `compiler-ir-validation` runs before each pass-specific postcondition, so a pass that drops a statement or corrupts a binding reference fails with a stable code attributed to the responsible pass rather than verifying as valid.
- **`runsAfter` is a hard requirement, not a hint.** A predecessor absent from the plan now fails `invalid-pass-order` with "requires missing predecessor". The earlier silent-satisfaction gap is closed — at the cost noted under Gaps.
- **Recursive binding normalization with a termination proof.** The composite pass alternates the object and array lowerings until the structural pattern residual reaches zero, and refuses with `unsupported-ir` if a round fails to decrease it. Nested, defaulted, rest and tuple-typed patterns all normalize; defaults refuse when null and undefined are not distinctly represented or undefined membership is unresolved.
- **Hoisting with definite assignment.** `validateIrFunctionVariableInitialization` (~990 lines) walks statements tracking initialization state through branches, loops, switches, try bodies and deferred closures, so a hoisted introduction read before any assignment is refused here rather than emitted as a Rust `let mut` the borrow checker will reject. This is the constraint the previous review predicted would need a Rust-side refusal; it landed as a neutral analysis instead, which is the better boundary.
- **Function-scoped variable contracts.** A hoisted variable must be mutable, must not carry an initializer when it is an iteration variable, and must agree on type across redeclarations — each a named refusal rather than a silent merge.
- **Caller isolation and determinism.** The runner clones caller input, clones again per pass, and preserves module identity; repeated plans yield equivalent output including failure identity and message.

## Gaps

- **The expression half of the domain does not exist.** Spread, call-site lowering, optional access, structural copy, and async suspension are all still refused by one or both backends with no pass to elect. `spreadCall`, `shapes`, `nullability` and the async refusals in both emitters are the pinned evidence.
- **Election is uniform, though divergence is real one layer down.** Haxe and Rust elect the identical six passes in the identical order, so nothing exercises pass _selection_. Divergence in what the targets do with the same neutral output is by now well established: Haxe emits native default parameters where Rust refuses, Rust renders a statement-value carrier as a block expression where Haxe needs an immediately-invoked function, and Haxe routes `Float32Array` through a runtime capability where Rust binds it natively. So the neutral-model-plus-target-election design is proven; what remains unproven is specifically that a backend can decline a pass its sibling takes.
- **`runsAfter` as a hard requirement narrows election.** Because a missing predecessor is now an error rather than a no-op, an elected set must be dependency-closed: a backend that wants `switch-fallthrough` must also take `variable-hoisting`. That is the safe direction to have chosen, but it means "elect the passes you need" is really "elect a closed subset", and no contract states which passes form a legal minimal set.
- **The composite pass reports a name that is neither accurate nor unique.** `createCompilerLoweringPassBindingPattern` returns `name: 'array-binding-pattern'` — the same identity the inner array pass declares, while the composite also lowers object patterns. Two consequences: an object-pattern refusal is attributed to `array-binding-pattern`, and a plan electing both the composite and the array pass is rejected as a duplicate name although it is a legal composition. The exported `object-binding-pattern` pass is reachable only through the composite today, so nothing surfaces the mismatch.
- **Redeclaration type agreement compares with `JSON.stringify`.** `addIrVariableHoistingDeclaration` decides "inconsistent redeclaration types" by string equality of serialized types, which is property-order sensitive; the runner's own idempotence check uses `isDeepStrictEqual`, which is not. Two structurally identical types built in different property order would refuse a legal `var` redeclaration. Not reachable through the current single lowering path, where key order is stable — but it is a canonical-shape-identity question, and `compiler-canonical-form` is where that answer belongs.
- **Hidden state rides on a `Map` subtype.** `IrVariableInitializationVariables extends Map<...>` with an optional `deferredClosures` property, populated by cast. The package's own posture — explicit data, plain records, no objects with hidden behavior — argues for passing the deferred-closure map as its own parameter.
- **No plan artifact or explanation report.** Order is validated from direct `runsAfter` names; nothing can print the resolved plan or say why a pass ran where it did. With four passes and two dependency edges that is still cheap to read from source, and it stops being cheap at eight.
- **Structural validity and a residual postcondition cannot prove semantic equivalence.** A pass that removes every C-style `for` by deleting it verifies. Each transform still needs construct-specific preservation tests and target parity evidence; the current tests do carry that weight, but nothing in the framework requires it.
- **Validation cost is one full walk per pass, per module, per target.** Every intermediate module is validated although only the last is emitted, so the same invariants are re-proved four times per module per backend today. Attribution is what that buys. If the pass count doubles, validating once on input and once after the plan keeps the guarantee and loses only the pass name.
