# Flight → C++ coverage plan

Bring the C++ target from the current share of the Flight SDK to zero refusals with compiling, behaviourally correct output. [`flight-cpp-adoption.md`](flight-cpp-adoption.md) is the register of work that must land downstream in `flight-cpp`; this document is the staged order of attack and the evidence it is derived from.

The measure of progress is the SDK corpus ledger, not `npm run readiness`. The golden corpus is a set of probes for behaviour the compiler already has, so it reports ~99% while most of the SDK refuses; `npm run readiness:corpus` reads the ledger a downstream run leaves behind and ranks refusal families by the modules they block directly and transitively.

## Running step list

Kept here so each round starts from the last one's answers rather than re-deriving them. Completed steps keep their evidence; the pending five are the current list.

### Done

1. **Does `flight-cpp` provide a type for erased `any`/`unknown` type positions?** No. Its only variants are `PropertyKey = std::variant<String, double, Symbol>` and `Presence<Value> = std::variant<Undefined, Null, Value>`. The compiler side of the corpus's largest family (~320 blocked modules) is closed; the ask is in [`flight-cpp-adoption.md`](flight-cpp-adoption.md).
2. **What sub-cause carries the auto-placeholder family?** Source-written `unknown`/`any`, not compiler residue. The top blockers are `AnimationChannel.targetRef` (99 dependents), `Node<any>` (76), `ApplicationWindow` (49), `GlContext` (25), `NodeInteractiveStateBinding` (17) — all fields or type arguments written as unconstrained types by the SDK, all now covered by one downstream ask.
3. **Is `CanvasRenderingContext2D` compiler-side?** No, and both halves are missing: `bindings/web-types.json` declares the settings type but not the context, and `flight/web_types.hpp` does not define it either. 53 of the 110 external-symbol refusals; recorded downstream.
4. **Can `PromiseFulfilledResult`/`PromiseRejectedResult` bind to something that exists?** Not faithfully. `flight::TaskSettlement<Value>` is the union of both arms, and the binding contract takes one `targetName`, so binding an arm to the settlement would misstate it. Recorded downstream.
5. **Can an emission refusal say where it came from?** It could not, and now it can. Every one of the 649 direct refusals in this document arrived as a message with no position at all — which is why several of the steps above were spent guessing at shapes instead of reading them. `BackendEmissionFailure` now carries the optional `line`/`column` of the declaration being emitted, `createBackendEmissionFailure` takes a position, and the C++ backend sets `currentOrigin` per declaration so `emissionError` attaches it. This is the same defect the lowering lane had before `83a03c67`, fixed the same way and for the same reason. Measured on regeneration: **refusals carrying a position go from 0 to 740 of 1743**, and the ledger's first stuck entry reads `abcFile.ts:99` rather than a bare message. Coverage is unchanged at 1108, which is what a triage fix should look like. The one deliberate exception: the unresolved-placeholder guard reads the assembled module rather than a declaration, so it carries no position rather than naming the last declaration it happened to emit.

### Next five

1. **Re-rank from the current ledger.** 803 direct refusals over 1,512 entries, and nothing above is ranked against it. The auto family and both helper families are closed, so the leaderboard is a different shape than any table in this document.
2. **Give a member binding a call-result type.** `Symbol.for` and `new Symbol` are the evidence: their results erase to `Any` where the old `auto` deduced the concrete type. `CompilerRuntimeExternalMemberBinding` carries only `sourceMember` and `targetName`, so this is a contract addition before it is a table entry.
3. **The placeholder guard: measured, and it is an architectural decision rather than a cleanup.** `assertCppOutputHasNoUnresolvedTypePlaceholder` is a text scan for `auto` in a TYPE position — `X<...auto...>`, `using X = auto;`, or a bare `auto x;`. `auto` in a value position with an initializer is deliberately allowed, which is why deduced locals and loop bindings do not trip it. **Ten shapes did not trip it either**: source-written `any`/`unknown` in a field, an array, an optional parameter and a `Record` value, plus residue from an unexpandable alias, an intersection alias, a generic intersection, mutually recursive aliases, a spread, an `Object.entries` destructuring and a shared capture. Combined with the corpus-wide note, the guard has no reachable input today.

   The election is why, and its own comment states the invariant it does not implement: _"residue from an alias the compiler could not expand still reaches the guard below as `auto` and stays refused rather than being silently widened."_ It cannot, because `source` does not separate the two cases it needs to separate. `{ kind: 'unknown', source: 'unknown' }` is what the source writes — and it is ALSO the synthetic missing-evidence fallback in **17 places** in the semantic lowering (`?? { kind: 'unknown', source: 'unknown' }` and `if (!x) return …`), plus `source: 'any'` fallbacks in the same shape. The election keys on exactly that spelling, so residue is widened to `flight::Any` identically to a written `unknown`.

   **The smallest shared evidence change was implemented and measured, then reverted.** It is one IR member (`unknown.source` gains `'unresolved'`), the 17 residue sites, and excluding `'unresolved'` from `isCppErasedDynamicValueTypeCpp`. It builds clean and costs **6 failures of 1935**: four semantic tests that assert the residue's current spelling, and **two backend tests in the `NodeOf<Traits>` intersection family — the corpus's largest blocked family — where the widening is load-bearing**. `returns the concrete overload result from findNodeByName` depends on residue receiving a representation; marking it `unresolved` changed that emission. So the change is not a free correction: it trades a pinned working shape in the largest family for an invariant with no proven counterexample of _silently wrong_ output. That is the decision to take deliberately, not an implementation detail, and it is deliberately not taken here. `golden:check` would also be the place to see the full cost, and it was not run because the change was not kept.

4. **The three defects `flight-cpp` named in this round.** `captured referent mutation of ctx` needs the compiler's reference representation for a captured binding, and the upstream example manifests need the Web host package declared.

   The third - a local array literal over native-binding property reads losing its element type (`const restored = [ctx.globalAlpha, ctx.lineWidth]` emitting `flight::Array<auto>`) - **does not reproduce against the pinned profile either**, and that is now measured rather than assumed. The shape was compiled with the real `bindings/web-types.json` from the pinned `flight-cpp`, and again with all seven profiles merged, over `CanvasRenderingContext2D` in three positions: a direct parameter, a member of an optional `context` after a null check, and a member of a structural row. **Every one emits `flight::Array<double>{ctx.global_alpha, ctx.line_width}`**, and the emitted header compiles against the pinned runtime, which declares both members as `double`. What the absence of the binding produces is a structured refusal, not the reported symptom: dropping the `externalBindings` manifest entirely, or supplying only `runtime.json`, refuses with `cpp-runtime-external-symbol-binding-incomplete` naming `CanvasRenderingContext2D`. So the shape has one refusal and one working emission and no silent-`auto` path between them.

   Nor is the cited source line in the SDK. `[ctx.globalAlpha, ctx.lineWidth]` appears nowhere; the real Canvas usage is a **write**, `state.context.globalAlpha = alpha;` in `scene2d-canvas/src/canvasRenderState.ts`. The array was this document's reconstruction of a save/restore shape, so the next attempt should start from the actual failing header rather than from this paragraph. Do not generalize from a manifest reconstruction, and do not special-case array literals: neither has produced the symptom, and the profile that would is the one already measured.

5. **Intersections, re-measured from the ledger and with the payload corrected.** The current ledger (`.dependencies/flight-cpp/generated/refusals.json`, `flight-generated-sdk-refusals/2`, 1766 entries) carries **five direct refusals with one identical message**:

   ```
   unsupported-ir  intersection types require C++ multiple-inheritance lowering:
                   no shape for NoInfer (argument unknown has no shape either)
   ```

   at `@flighthq/node` `boundsRectangle.ts:246`, `hierarchy.ts:123`, `nodeOrderList.ts:250`, `traversal.ts:19`, and `@flighthq/scene3d` `billboardCamera.ts:76`. **The old `Aabb` payload this entry used to carry is stale** — lowering the real `Aabb.ts` and the real `types/src/Node.ts` verbatim both emit today. The payload is `NoInfer`, and it is the _same_ payload at every one of the five sites, which is why the message is the instrument here.

   `NoInfer<T>` itself is **not** the missing rule. It lowers as `T` in all three shapes tried — inside an alias body, standing alone, and as a direct intersection member — so `NodeOf<Traits>` spells `flight::StructuralRef<flight::RowMerge<RowOf<Ref<Node<Traits>>>, RowOf<Traits>>>` and `NoInfer<Traits>` alone spells `Traits`. The failing instantiation is `NoInfer<unknown>`, i.e. the alias reached with `Traits` uninstantiated.

   **Reproduction did not land, and that is the state to start from.** A faithful reconstruction of the whole chain — the real `hierarchy.ts` verbatim, a real-shaped `getNodeRuntime` with its `Traits = NodeTraits` default, and a real-shaped `Node`/`NodeRuntime` including the computed `EntityRuntimeKey` member — **emits**. So the trigger is a property of the real graph that a stub does not carry, and the next attempt needs either the ledger's transitive context for one of the five modules or leave to lower that module's real dependency set rather than reconstruct it. **It is a compiler-side lowering error rather than a downstream one**: the payload names only compile-time concepts, no runtime symbol or profile binding appears in it, and `NoInfer` is erased at runtime, so there is no contract for a runtime to satisfy.

6. **Finish what the optional-function fix revealed.** It is the next blocker for 25 of the 61 modules it cleared, and the payload is specific: `contextual union value type std::function<flight::Ref<…>(flight::StructuralRef<…>)> is not a represented runtime domain`. Two paths spell the same function type and disagree — the union plan's value slot and `emitType` — because a plain `void(double)` slot and a `Ref`-parameter slot both work while the structural-row-parameter form does not. Find where the slot type is built and make the two agree rather than adding a second spelling.
7. **Then the evidence families**, re-ranked: contextual union conversion (229 direct, 102 blocked) and the remaining union value-slot payloads (`flight::Map` 9, `Ref<GlRenderTarget>` 8, `flight::Any` 7).

## Where the number stands

| Ledger                                         | Compiler   | Emitted     | Direct | Propagated |
| ---------------------------------------------- | ---------- | ----------- | ------ | ---------- |
| After the erased-value election                | `04b4fd35` | 1339 / 2851 | 806    | 707        |
| After Stage 1                                  | `bbf51466` | 1108 / 2851 | 649    | 1094       |
| Mid Stage 1 (partial-row collapse only)        | `d12e08ca` | 1107 / 2851 | 650    | 1094       |
| Fresh SDL-profile run (plan baseline)          | `9cc35da`  | 1106 / 2851 | 651    | 1094       |
| Committed `.dependencies/flight-cpp/generated` | `9f6ce1c`  | 950 / 2851  | 1105   | 796        |

The committed ledger was produced 153 commits behind this tree, so it is not attributable to current work and must not be read as a delta. Regenerate before reading any number as this repository's.

Inputs: Flight SDK `1274ec5c923947dc64d5ffedcbd8169fc758cd9f` (@flighthq/sdk 0.5.0), 154 packages, 2851 modules, the seven SDL binding profiles.

## The compile gate runs now, and it changes what counts as progress

Two installs unblocked the checks this document repeatedly called unverifiable: `g++` (15.2.0, the same version the downstream audit used) and `libsdl3-dev`, without which 79 of the failures were only `SDL3/SDL_video.h: No such file or directory`. `npm run compile:check` and the downstream `sdk:compile:sdl` both run to completion here now, and they must be run before any emission change is called an improvement.

**Measured at `3d2fbe67`: of 1,354 emitted modules, 1,310 compile and 44 do not.** The same measurement read 1,282 of 1,339 at `4dbb73b7` before the projected-member fix below, so that fix moved emitted by 15 and compiling by 28 — thirteen modules were already emitting and failing on a member spelling.

Emitted and compiling are not two strengths of one signal — they are orthogonal, and a fix can move the compile count while moving the emitted count by exactly zero. builder5 supplied the proof from the same week: a clipboard fix changed two calls on a `std::optional` to `row_get`, the emitted module count did not move at all, and the golden corpus had no fixture for it. Anyone reading emitted count as progress would have scored that fix at zero. Treat compiling as the primary number for representation work and emitted count as a separate question that can be flat across real work.

The failures are four classes, three of them with a reproduction:

- **36 `name not declared`.** `flight/types/has_appearance.hpp` uses `Node<Traits>` inside `RowOf<flight::Ref<Node<Traits>>>` without declaring it — the module forward-declares names it references, but not one that appears only as a template argument inside a row projection of a materialized alias. `has_transform2d`, `has_transform3d` and `update_particle_objects` are the same.
- **29 `flight::Any` mismatch.** These are the election's cost. `const first = bytes[index++]` compares a value whose IR element type was never recorded, so `auto`, which deduced the element, has become `Any` and `Any >= double` does not compile. The election did not create the missing evidence; it removed the deduction that was hiding it.
- **5 runtime member name.** The compiler emits `to_lower_case` where the runtime spells it `to_lower`.
- **52 other**, including a class the election surfaced: `redeclaration of 'flight::Any flight::types::GlContext::viewport'`.

The tension worth stating plainly: the election moved some modules from _refusing_ to _emitting code that does not compile_. This repository requires emitted source to compile, so by its own rule those are defects now, not refusals — and the compile gate is the only instrument that says so. Every remaining stage must be measured against 1,216, not 1,339.

## The `flight::Any` arithmetic family is a trade-off with a named correct fix, not a missing operator

Twenty-six of the forty-four compile failures are one shape: a value erased to `flight::Any` and then used as a number. The tempting read is that the runtime lacks `operator>=`; it is not, and adding operators would fix none of `Array<Any>::push(Ref<X>)`, `(flight::Any)()` or `cannot convert Any to double`.

The reproduction is two lines:

```ts
const codePoint = text.charCodeAt(0); // emits `auto code_point = ...`   — compiles
let codePoint = text.charCodeAt(0); // emits `flight::Any code_point`  — does not
```

Both recorded types are `unknown`, because the call-result evidence was missing when the binding type was recorded. The difference is the storage decision: a non-mutable binding with an initializer keeps C++ deduction, which is never wider than erasure, and a mutable one takes the erased value because it may be reassigned across alternatives. That decision is what `encoding/utf8.hpp` fails on — `let codePoint = text.charCodeAt(index)` inside a loop that never reassigns it to anything else.

So the storage choice is a real trade-off and neither side is free: relaxing it for `let` fixes this family and breaks a later reassignment across alternatives; keeping it is safe and breaks arithmetic on a value whose type was merely unrecorded. **The fix is neither.** `charCodeAt` returns `number`, the compiler knows it, and the binding should say so; the erased value is a symptom of evidence that was never recorded, and `Symbol.for` is the same gap in a different shape. Note that the backend already has the answer for the _call_ — `getCppRuntimeMemberCallResultTypeEvidence` returns `number` for `charCodeAt` via `cppNumberReturningStringCallNames` — and the _binding_ never sees it.

## The plain-object host seam: one defect, fixed; one withdrawn

Flight `7e2fc7df5378313ceaf21ba8d6ef39cc18a6f4ad` removed `extends Entity` from the host capability interfaces (`2b8c7656`) and builds capabilities as plain objects (`5a251b69`). The shape is modeled end to end in `cppCompilerBackend.test.ts` — `types/HostGl.ts` declares `HostGlCapability`, `host-web/webGlHost.ts` exports a plain object satisfying the optional-member bag, and `app/appWindow.ts` receives the capability as a parameter and calls through it.

**Defect 1, the `row_get` static assertion, is withdrawn.** It was my harness, not the compiler. `row_get<RowKey<"acquire">>` resolves through `flight::detail::generated_row_member`, a table that is not part of the runtime: `flight-cpp`'s `scripts/sdkGeneration.mjs` generates it per project by scanning the emitted headers for every `flight::RowKey<"...">` and binding each name to the member of that name. My first translation unit included only the runtime, so the table was absent, `generated_row_member_t` fell to `void`, and the static assertion fired on a shape the compiler does not own. With a table built the way the generator builds one, the seam **compiles and runs**: a direct TU including the three emitted headers, constructing the provider's object literal, passing it to `attach_window_render_context`, calling all three methods, and reaching both the present and the absent optional member. Record the rule that outlived the finding: **a shape that fails to compile is not yet a compiler defect until the harness that failed it is itself resolved.**

**Defect 2 is fixed**, and it was never only about the seam. A presence test (`x === undefined`, `x !== undefined`, and the loose forms) was emitted as a storage query on evidence from one axis. Two axes decide it:

- **Storage** asks whether the emitted expression carries absence. Only `std::optional<...>` and a `flight::Presence` variant do. This is the axis a `Readonly<Record<string, V>>` index read needs, because its type shows no union while the lowering elected `std::optional` storage for it.
- **Type** asks what the declared type admits. This is the axis a `flight::Ref<T>` field needs, because its storage is a `std::shared_ptr` with no presence to query and the source's comparison is a tautology it wrote deliberately.

Reading only one axis produced three spellings that cannot compile, all with the same cause: `group->context != flight::undefined` (no overload for a reference), `value.has_value()` on a `flight::String`, and `!value.has_value()` on a `std::shared_ptr` field. `emitCppPresenceTestCpp` now owns the whole decision, `hasCppAbsenceStorageCpp` owns the storage axis once for both this lane and `??`, and a type that excludes the sentinel is answered at compile time — the same rule the `??` lane already applied to a non-nullable left operand.

**A fourth storage, now answered.** An erased dynamic value (`any`/`unknown` storage, `flight::Any`) keeps presence in its own kind tag, and the runtime names the test: `is_undefined`, `is_null`, and `is_nullish`, with `is_nullish` documented as exactly the loose comparison. No ABI addition was ever needed — only a decision that the backend may name those members directly, the way the erased-value assertion already names `as_number` and its siblings. `emitCppPresenceTestCpp` spells them, strict comparisons asking the named predicate and a loose one asking `is_nullish`.

Which shapes have that storage is a **decision, not an annotation**, and the two disagree in both directions. A `let` annotated `any` is erased because it may be reassigned across alternatives. A `const` keeps whatever its initializer proves, so `const rows = grid.length` is a `double` and its comparison folds to `true` — an annotation of `unknown` there describes nothing the storage does. Asking the annotation gets both of those backwards, so the declaration's own storage decision is collected into `erasedDynamicStorageBindingIds` by one function, `hasCppErasedDynamicStorageCpp`, that both the collector and the presence test read. A member is a different case and needs no second source: a field is emitted with its declared type, so there the type _is_ the storage.

**The fourth storage exposed a fifth defect, which is what finding one representation gap tends to do.** `flight::Any` has no constructor for `std::nullopt`, so `value = undefined` on a mutable erased binding emitted an assignment that cannot compile. `emitUndefinedWithExpectedTypeCpp` now spells the sentinel through the value itself when the expected storage is erased — the same projection reached through an assignment instead of a test.

The model needed correcting on the way, which is worth recording: a first version supplied `importer` identities on the module-resolution edges, and with those the resolution found no targets, so the consumer emitted bare `Surface` with no include and no forward declaration — which looks exactly like a missing-declaration defect and is not one. The resolvable form is an edge with `specifier` and no importer, matching the other multi-module tests in the file.

`golden/nullishPresenceTest` and `golden/erasedPresence` pin the rule where `npm run compile:check` can reach it. Neither pins the seam: `compile:check` hands each fixture header to `g++` **on its own**, and a row read needs the generated member table, which is a per-project artifact and not part of any single header. The seam's compile-level proof is therefore the direct TU described above, not a fixture. `golden/erasedPresence` cannot carry the field case for the same reason, so that one lives in the unit test and the direct TU.

## Two failures the Flight `7e2fc7df` batch exposed, both fixed

**An anonymous structural type could be named two different things in one package.** `collides.hpp` defined `kind_<hash>_1` under `FLIGHT_COMPILER_ANONYMOUS__…_<HASH>` while `plain.hpp` guarded **that same macro** and defined `kind_<hash>`. Including one suppressed the other's definition, so the suppressed one's uses had no declaration at all — `'kind_…_1' was not declared in this scope` — and nothing reported it, because the preprocessor removed it.

Two causes needing two fixes. The name was resolved against the module's own `generatedNames`, a mutating set that a **probe emission into a throwaway context** also feeds: the object-shape equivalence check emits each property type into `{...context, anonymousStructs: new Map()}`, which shares `generatedNames` and discards the struct. So the same shape could resolve `kind_<hash>` in one module and `kind_<hash>_1` in another, decided by emission order. Naming now lives across the modules of one emission — seeded from the package-wide declared names every module sees identically, memoized per structural key — so one shape names one type wherever it is written. The guard is derived from the resolved **name** rather than from the hash, so definition, guard, and forward declaration cannot disagree. One golden fixture moved, and only in its guard stem.

**A finite-key indexed access on a reference emitted a subscript.** `signals[name]` with `name: 'onComplete' | … | 'onStop'` and `signals: Ref<MediaChannelSignals>` emitted `signals.value()[static_cast<size_t>(name)]`, and `shared_ptr` has no subscript. The row mechanism cannot help either: it has a static-keyed `row_get` and a `Symbol`-keyed one, and no string-keyed form, so this is a compiler-side lowering rather than an ABI addition.

The closed union is what makes it lowerable, because it enumerates the members the access can reach; the access becomes a selection over exactly those, receiver bound once, unreachable fall-through still present. Lowered only when proven — every key must name a member the object emits (`cpp-closed-key-absent-member`), no member may be optional, and the named members must lower to one C++ type — and a key widened to `string` refuses with `cpp-object-index-without-closed-key-set`. That last refusal is narrowed to reference-represented objects **with named members**, because its first version also caught `{ [index: number]: number }`, a carrier erased to a generic parameter precisely so it can stand for anything that subscripts.

## Dynamic named reads over a structural object

`@flighthq/host` was 0/6 on one direct root: `explainHost` writes `Object.entries(host)`, `Object.keys`, and `value as unknown as Record<string, unknown>` followed by a computed read. The two `Record` shapes are how the source makes a dynamic named read type-check, and neither is a `flight::Record` — the properties already exist on an object, so the runtime's read-only `flight::NamedProperties` view is what they mean. The generic `Object.keys`/`Object.entries` bindings could not serve them: the runtime's `object_keys`/`object_entries` take a `Record` or a container with `begin()`, and a structural object is neither, so `Object.keys(host)` emitted a call with no matching overload.

The cast now lowers to `flight::named_properties(source)` — the view IS the value of the cast — and a binding whose initializer is that cast takes the view as its storage rather than the `Record` its declared type names. `Object.keys`/`Object.entries` over a view or a structural object emit the primitive's own `keys()` and a `get` per key, in the primitive's order, which is source declaration order; the emitter neither sorts nor counts. A view read is excluded from the element-optional storage, because it answers `flight::Any` where an absent key reads as `undefined` into the value itself, not `std::optional`.

Three refusals, each with its own rule, because each is a different question: a write through the view (`cpp-named-properties-write-unsupported` — the view is the read side only), a `PropertyKey`-keyed view over a view (`cpp-named-properties-symbol-key-unsupported` — the view reports own string keys and a symbol of the same spelling is a different property), and a view over an erased value (`cpp-named-properties-source-unproven`).

**The last one is the root that remains, and it is a runtime gap.** `explainHost` enumerates the host and then enumerates each capability group it _found_, and the value it found is the erased `Any` the first enumeration produced. `named_properties` takes a `shared_ptr<Object>` or a `StructuralRef`, and `flight::Any` recovers an object only through `object_if<T>()`, which needs the type. So the second-level read has no runtime operation: what is missing is a way to reach the view from a stored erased object, for example an overload taking the `AnyObject` the value already carries. Until then the compiler refuses rather than emitting a cast that cannot compile.

`typeof` over the erased value was the other root on the way and is closed: `Any::type_of` is ECMAScript `typeof`, including the `null` that reports `object`, so the emitter asks the value instead of folding a shape the source did not state.

## Reproducing the ledger locally

The corpus cannot be generated from inside this repository — the request needs a target repository's package graph, package targets, and binding profiles. It can still be generated on a machine with a Flight checkout, and doing so is the first step of every stage below.

1. Fetch the pinned Flight SDK outside this repository and check it out (nothing from it is committed).
2. Copy `flight-cpp` to a scratch directory and point its `.dependencies/flight` at that checkout and `.dependencies/flight-compiler` at this working tree.
3. Re-pin the copied `dependencies.lock.json` to this checkout's `HEAD`, because rehydration gates require each dependency to be clean and at the pinned revision.
4. Run the copied `sdk:generate:sdl` script with `--output=<scratch>/out/sdk-sdl`.
5. `npm run readiness:corpus -- --corpus=<scratch>/out/sdk-sdl`.

Step 4 rebuilds this repository and takes roughly three and a half minutes for the full 2851-module graph.

Two properties of the ledger decide how it is read:

- **A refused module records only its first failure.** A module blocked by a family may hold further refusals behind it, so every count below is a lower bound on that family's true reach, and each stage must be re-measured rather than extrapolated.
- **`dependency-refused` entries name the edge, not the module.** The blocked-dependents column is a dependency-closure estimate and is directional, not exact.

## Ranked blockers

Direct refusals are modules the compiler refused on their own contents; blocked is the dependency closure behind them — the modules that would become reachable if that family were resolved.

| direct | blocked | family |
| --- | --- | --- |
| 18 | 446 | `unsupported type ConditionalType` — cleared in Stage 1, now zero modules |
| — | — | `flight-cpp type position retains unresolved auto placeholder` — cleared in Stage 2, now zero modules |
| 46 | 91 | `runtime external symbol binding plan is incomplete` — down from 110 |
| 118 | 156 | `contextual C++ union conversion requires equivalent source union evidence` |
| 61 | 94 | `contextual optionalSingle construction requires expression type evidence` |
| 30 | 51 | `type assertion target must identify exactly one C++ variant alternative` |
| 5 | 40 | `contextual union value type flight::Map is not a represented runtime domain` |
| 34 | 34 | `anonymous object property <property> requires concrete C++ type evidence` |
| 18 | 25 | `typeof requires closed runtime type evidence` |
| 19 | 23 | `typeOf types require C++ type computation lowering` |

The single most blocking module in the corpus is `@flighthq/types/packages/types/src/AnimationChannel.ts` at 99 blocked dependents, followed by `@flighthq/types/packages/types/src/Node.ts` at 76 and `@flighthq/types/packages/types/src/ApplicationWindow.ts` at 49. `@flighthq/types` alone carries 56 of the 651 direct refusals and 252 refused modules.

## Stage 1 — the `PartialNode` helper (18 direct, up to 446 blocked)

Seventeen of the eighteen `ConditionalType` refusals are one root cause. Every one of those seventeen modules imports `PartialNode` from `@flighthq/types`:

```ts
export type PartialNode<T> = {
  data?: Partial<T extends { data: infer U } ? U : never>;
} & Partial<Omit<T, 'data'>>;
```

The set is exactly `@flighthq/node` (node), `@flighthq/scene2d` (displayObject, displayContainer, htmlView, scale9Sprite, sprite), `@flighthq/shape` (shape, morphShape, scale9Shape), `@flighthq/text` (nativeText, richText, textLabel), `@flighthq/tilemap`, `@flighthq/movieclip`, `@flighthq/particleemitter` (particleEmitter, particleEmitter3D), and `@flighthq/quadbatch` — the display and node foundation the rest of the scene graph sits on. The eighteenth module is `@flighthq/interaction/interactionManager.ts`, which declares its own distributive conditional over signal-name literals.

### What the helper actually is

`PartialNode<T>` is a bag of the node's own named properties with every member optional — "any named property of a node, without requiring the whole thing", which is how call sites use it: `createNode3D(source.kind, { alpha, enabled, name, visible })` and `createNode3D(node.kind, { name: node.name })` pass arbitrary subsets. Checking the alias against the TypeScript checker confirms it: for `PartialNode<Node>` the properties are `data?, enabled?, name?`, and it is assignable to `Partial<Node>` in one direction only, because `data`'s value type is `Partial<T['data']>` rather than `T['data']`. So the alias is a partial structural row over the node's row, with one member — `data`, itself a bag — narrowed to a partial of itself. `data` is not special; it is the one named property whose value happens to be another bag, which is why its consumer casts it: `createData(obj?.data as Partial<Data>)`.

This matters because **the representation already exists and the concrete form already lowers to it.** With the conditional written out concretely, this compiler emits the bag exactly as described — a nominal struct whose members are all `std::optional`, `data` among them holding a nested partial struct, passed as `StructuralRef<RowReadonly<RowOf<Bag>>>`. No new runtime primitive is needed for the generic form either: the backend already emits `Omit<T, K>` over a reference-preserving subject by projecting nothing and keeping the subject's own row, so key removal is a type-level refinement the row carries through its accessors. An earlier draft of this plan asked downstream for a "row minus one key" projection on the assumption that it did not; that ask is withdrawn.

### The decision, and the one site it lands at

**The chosen lowering is the row-partial form with the narrowing carried by the cast.** A generic C++ template alias can already express "every member of the node's row, optional" — this compiler emits `template <typename T> using Bag = flight::StructuralRef<flight::RowPartial<flight::RowOf<T>>>;` today for a plain `Partial<T>`. What it cannot express per-member is the single narrowed `data`. But it does not have to: the narrowing is a TypeScript convenience that makes `createData(obj?.data as Partial<Data>)` check, the cast is written at every consumer already, and the runtime behaviour is "accept any subset", which `RowPartial<RowOf<T>>` states directly. So the alias lands on the row-partial form and the cast carries the rest. One definition, no per-site special-casing, and nothing a C++ reader cannot see.

### Where the work actually lands, which is not where it looks

The seventeen modules split by instantiation — sixteen pass a concrete argument (`PartialNode<Node2D>`, `PartialNode<Shape>`, `PartialNode<TextLabel>`, …) and only `@flighthq/node` passes a generic one — but **the split does not map onto two code paths, and an infer-binding fix does not work.** That was the plan's first assumption and it is wrong; the trace below is why, and it is worth not rediscovering.

Both instantiations funnel through the **declaration-site** lowering of the alias body: `lowerTypeAlias` → `lowerType` → the intersection's object member through `lowerTypeScriptTypeProperties` → `lowerType` on the conditional. That path carries **no substitutions**, so by the time the conditional is lowered the concrete argument is gone and `Value` is a free type parameter with no constraint — `checker.getTypeOfPropertyOfType` has nothing to read, and binding the `infer` variable is not merely unimplemented but impossible there. The substitution-carrying resolver that _would_ carry it, `lowerConcreteTypeScriptConditionalTypeEvidence`, exists and is live — it is entered twice across the whole `compiler-semantic` suite — but it is not on this path, and an infer binding added to it changes nothing here. Verified by instrumenting all three: the evidence resolver is never entered for the failing shape, while `lowerType`'s conditional arm throws for it six times.

Two consequences worth carrying into the work:

- **The fix is one change, in the declaration-site path**, and it is the row-partial collapse above rather than an infer binding. It has to hold for a free `T`, because the concrete argument is already erased when it runs.
- **The consumer's error is a propagation, not a second site.** The throw happens while lowering the imported declaration and is caught by the _consumer's_ top-level statement loop, so the diagnostic names the consumer as `source` while its message names the file the syntax is in. That is also why the position was meaningless before `83a03c67`, and why the sixteen concrete modules are not currently listed as dependency-refused on `node.ts`: they record their own first failure, and the dependency edge only becomes visible once it clears.

### What landed, and what it revealed

`2ed2a2ef` takes the first half: **the consumer no longer carries the helper's refusal into its own module.** `getTypeScriptNarrowingAlternatives` resolved a named type through its declaration and lowered that declaration's body in the _declaring_ module's context with no `try`/`catch`, so an unexpandable helper threw out of the consumer's statement loop. Its sibling resolver for the same shape already caught `isUnsupportedSyntaxFailure` and kept the named type; this one now does too.

Verified against the corpus, not extrapolated. The `ConditionalType` family goes **18 direct modules to zero**, the three named tests go green, and `npm run golden:check` is unchanged at 604/604 — emitted output did not move. Total coverage is unchanged at 1106/2851, which is the point below.

- **Each module now reports its true next blocker**, which is what the family was hiding. `@flighthq/node`'s `node.ts` and `@flighthq/scene2d`'s `displayObject.ts` move to `Partial<T> requires a statically resolvable C++ object shape`, because the consumer keeps the named reference and the helper's alias behind it is still opaque. The other fifteen move straight past `PartialNode` to their real blockers — `structural-row projection requires a represented object-reference target`, `contextual optionalSingle construction requires expression type evidence`, `contextual C++ union conversion requires equivalent source union evidence`, `type assertion target must identify exactly one C++ variant alternative`. Those are Stage 3 families, and they were invisible before.
- **This is the lower-bound property working as designed.** Thirteen of the seventeen were never about `PartialNode` at all; the compiler simply stopped at their first failure. Anyone reading coverage numbers should expect the same again from every stage.

### The remainder

`d12e08ca` takes the row-partial decision. `PartialNode<T>` is a partial row that re-states one of the members the `Omit` removed, so once the row _is_ the representation the re-statement is a type-level refinement the row carries — which is already how the backend emits `Omit` over a reference-preserving subject, projecting nothing and keeping the subject's row. `lowerTypeAlias` now recognises that shape and lowers the whole body as `Partial<subject>`. The emitted header is one definition and no per-site machinery:

```cpp
template <typename T>
using PartialNode = flight::StructuralRef<flight::RowPartial<flight::RowOf<T>>>;
```

`PartialNode.ts` now emits, and the two modules that were held by it move on. **The blocker there is not `PartialNode` at all — it is the second helper in the same file.** `node.ts` and `displayObject.ts` both fail on `Partial<MethodsOf<…>>`:

```ts
export type MethodsOf<T> = { [K in keyof T as T[K] extends (...args: any) => any ? K : never]: T[K] };
```

`MethodsOf` is a mapped type whose key remapping is a conditional, so it lowers to an opaque alias, and `Partial<opaque>` is what refuses.

**Key projections are representation-carrying — decided, and the policy test changed with the decision.** Extending the Stage 1 recognition to "a mapped type over `keyof Subject` that keeps `Subject[Key]` as written" was first implemented and reverted, because it turned two tests red and one of them was the policy itself: `keeps ambient utilities named and expands only checker-concrete mapped types` asserted that `export type Generic<Value> = { [Key in keyof Value]: Value[Key] }` — an identity projection over a generic parameter, the mildest case there is — is _omitted_ with an `unsupported type MappedType` diagnostic. That made it a policy decision rather than a fifth application of the Stage 1 pattern, and it was taken deliberately rather than inferred from momentum: a generic key projection is representation-carrying, exactly as `Omit`'s key removal already is over a reference-preserving subject.

The two tests were updated to the new policy rather than deleted — `Generic` now lowers to its subject, and the unsupported-families test lists `Mapped` among the resolved declarations and no longer expects its diagnostic. Nothing else was relaxed: the recognition requires a mapped type whose constraint is `keyof` the alias's _own single type parameter_ and whose value type is `Subject[Key]` as written, so a mapped type over a literal union (`[Key in 'ready' | 'done']`) and a mapped type over a concrete subject are unaffected.

`MethodsOf`'s own specification test still enforces the filter at the source level — `WidgetMethods['id']` is a `@ts-expect-error`, and `MethodsOf<DataOnly>` is asserted empty. What the decision settles is that the _emitted storage_ does not re-enforce it: the row is the subject's, and a caller who passes a member the selection excluded is refused by the source types rather than by the generated header. The emitted alias is degenerate and honest about that:

```cpp
template <typename T>
using MethodsOf = T;
```

### The yield, measured

**1106 → 1108 across the whole stage** — two modules, one per helper, both of them the helper's own file (`PartialNode.ts`, then `MethodsOf.ts`). Both refusal families are now empty. Everything else the stage was expected to reach reached its _next_ blocker instead, and that is the honest number: this stage bought the mechanism and the diagnosis, not the closure.

What the two modules revealed once the helpers stopped standing in front of them:

| module                                 | next blocker                                                                |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `@flighthq/node` `node.ts`             | `structural-row construction requires explicit named properties`            |
| `@flighthq/scene2d` `displayObject.ts` | `contextual C++ union conversion requires equivalent source union evidence` |
| `@flighthq/shape` `shape.ts`           | `structural-row projection requires a represented object-reference target`  |

Those are Stage 3 families, they were invisible while the helpers stood in front, and they confirm the lower-bound property a third time: two helpers cleared, and the modules behind them simply moved to the next refusal rather than emitting. Expect Stage 3 to behave the same way, and rank it from a fresh ledger rather than from this table.

**Verification.** The three named tests go green; `npm run test` holds its pre-existing failure count; then §Reproducing the ledger, expecting the seventeen modules to emit and the dependency closure behind them to open. Read the new ledger before starting Stage 2 — the yield will be lower than 446, because each module records only its first refusal.

## Stage 2 — an erased value for `any` and `unknown` type positions (64 direct, up to 315 blocked)

**Done, and it is the largest single step so far.** `flight-cpp` added `flight::Any` — a closed variant over every language type the runtime has, so a position written `unknown` that holds a number stays a number — and this compiler elects it. The election goes in `emitTypeCpp`'s `unknown` arm, after the `this` and `object` cases; it cannot be reached through a binding profile, which is why it needed a compiler change rather than a profile entry.

**Measured: the auto-placeholder family falls from 69 direct modules to zero and the corpus goes from 1,108 to 1,339 emitted of 2,851.** That is 230 modules from one arm of one switch. It is also the whole of what the ranking called the largest lever, and the reason the earlier framing — that a rough half of the 1,108 → 1,500 band lived downstream — was right.

**The election is scoped to positions with nothing to deduce from, and that scoping is load-bearing.** Taking the whole `unknown` arm to `Any` regressed `const rows = grid.length` — a `const` with an initializer whose recorded type is unconstrained — from `auto rows`, which deduces the `double` the initializer already states, to `flight::Any rows`, which erases a type that was never in doubt. The golden corpus caught it. So a non-mutable binding with an initializer keeps the deduction, and the erased value serves the positions that have none: fields, parameters, type aliases, and mutable bindings that may be reassigned across alternatives. The distinction is the initializer, not the type: where C++ can deduce, deduction is never wider than erasure.

Two things to carry forward. The election also catches the opaque-alias residue Stage 1 left behind, because that residue is produced as `IrType { kind: 'unknown', source: 'unknown' }` and `unknown` is one of the two sources the election names. `flight-cpp`'s record expects residue to stay refused as `auto`; it does not, and the unresolved-placeholder guard is consequently unreachable across the whole corpus. Either the election spares residue or the guard goes — leaving both means a guard no test can reach. And the election _exposes_ a precision gap rather than causing it: a callable whose result type is not bound, `Symbol.for` and `new Symbol` in evidence, now erases to `Any` where the old `auto` deduced the concrete type from the initializer. Sound, but wider; a member binding cannot carry a call-result type today.

### Two fixes with a compile gate behind them

**A projected member takes its spelling from the binding table** (`3d2fbe67`). `string.toLowerCase` was already bound to `to_lower` — the binding was right — but the optional-chain projection spelled the member from the _source_ name with `safeCppName`, producing `to_lower_case`, which is not a member of `flight::String`. The symptom looked like a missing table row and was a path that never consulted the table. Worth remembering: `url.split('?')[0].split('.').pop()?.toLowerCase()` was the reproduction, and the identical symptom has a different cause one layer down, where `expression.member` is undefined because the semantic layer does not resolve a member against an optional payload. That second half is NOT fixed.

**Five installs turned the caveat into a measurement.** `g++` and `libsdl3-dev` did for the compile gate what nothing else could: the golden fixtures, the corpus, and every claim about emitted output are now checked by a compiler rather than by comparison with output this compiler produced. Two defects were found this way that no other gate could see — a cast from the erased value that nothing could compile, and the member spelling above — and in both cases the emitted and compiling counts disagreed, which is the only reason either was noticed.

## Stage 3 — construction and assertion evidence

Ranked against the ledger at `bbf51466` rather than the plan baseline, because Stage 1 moved this group.

### Open with the symbol-keyed structural row (7 direct, and `node.ts`'s 24 dependents behind it)

The highest-leverage compiler-side item left, and it is small and fully reproduced. `node.ts`'s `createNode` builds its result as a structural row and includes a computed member:

```ts
const out = { data: …, name: …, kind: nodeKind, [EntityRuntimeKey]: runtimeFactory() } as Node<Traits> & Traits;
```

The C++ structural-row construction path accepts only `kind: 'property'` members, so any `computedProperty` refuses the module (`cppCompilerBackend.ts`, the non-spread arm of the structural-row construction). Seven modules refuse on exactly this and the other six are `application-gl`'s `glApplicationRenderView`, `materials`' `materialPresets` and `phongToPbr`, and the three pipeline modules `scene2dCanvasPipeline`, `scene2dGlPipeline`, `scene2dWgpuPipeline`.

Reproduced at minimal size: a `declare const RuntimeKey: unique symbol`-style key in an object literal cast to a structural row refuses with this exact message.

The naming is available and sound. The SDK writes `export const EntityRuntimeKey = Symbol.for('EntityRuntime');` — a **global-registry** symbol, so its description is a stable identity that two distinct keys cannot share, unlike a non-global `Symbol('…')`. The compiler already names symbol-keyed members elsewhere (an emitted member is spelled `entity_runtime_key`), so what remains is carrying that name into the row key and into `emitCppStructuralRowSchemaTypeCpp`, and keeping the refusal for a computed key that is _not_ statically nameable. Prefer the row-key spelling over emitting the symbol's runtime value as a key: a row key is a compile-time name, and `flight::Symbol::for_key` is the binding for the `Symbol.for` _call_, not for a row position.

### Then the evidence families

Three families share one shape: the compiler has the contextual slot but not the evidence to fill it.

- `contextual C++ union conversion requires equivalent source union evidence` (217 direct, 83 blocked) — the source union and the target variant do not line up. The largest direct count in the corpus, but spread thinly: its top packages are `scene3d-gl` (15), `scene3d-wgpu` (12), `render-gl` (11), `scene2d-gl` (11), and its blocked count is low because these are mostly leaves rather than foundations. High effort per module won.
- `contextual optionalSingle construction requires expression type evidence` (81 direct, 60 blocked).
- `type assertion target must identify exactly one C++ variant alternative` (72 direct, 33 blocked).

These are semantic-lowering work of the ordinary kind: extend the evidence each site collects rather than adding a fallback.

## Stage 4 — host bindings (83 direct, 158 blocked)

`runtime external symbol binding plan is incomplete` names symbols the C++ binding table does not bind and no binding profile declares: `CanvasRenderingContext2D`, `AudioContext`, `FontFace`, `Geolocation`, `MediaStream`, `Locator`, the `Intl` option types. The runtime lane is proven-total, so every reachable symbol must receive exactly one decision — which is the gate working as designed, not a defect.

Most of these are `discovered-partial` host endpoints and belong in a binding profile, which is configuration rather than compiler work. Two are not: `PromiseFulfilledResult` and `PromiseRejectedResult` are ambient `Promise` types, the same lane as `Promise` itself, which the C++ table already binds as a `task` runtime capability. Those belong in the binding table beside `Promise`.

## Long tail

The remaining families each block fewer than forty modules; `npm run readiness:corpus` lists all of them by payload. Work them from the ranked list the ledger prints, not from this document.

## Invariants each stage must hold

- No approximate, opaque, or silently omitted emission. A representation the target cannot express is a structured refusal, never a fallback that looks like success.
- A stage is measured, not extrapolated: every count in this plan is a lower bound, so re-run §Reproducing the ledger before starting the next stage and re-rank from the ledger's own output.
- Compiler work stays compiler work. A `discovered-partial` host endpoint is a profile entry; a runtime lane capability is an ABI decision; neither is fixed by weakening an assertion.
- Deleting a test that encodes an intended behaviour is not a fix. The three red tests in Stage 1 are the specification.
