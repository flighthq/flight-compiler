# Compiler Breadth Analysis

A companion to [the package reviews](packages/index.md). Those ask how completely each existing package expresses its domain. This asks the two questions they cannot: **are there domains with no package at all**, and **is the decomposition itself right** — does each package own one irreducible job.

## Method, and the test a new cell has to pass

A missing cell is not "a concept we could name". It is a concept the repository **already names and cannot place**: something the refusals point at, the architecture diagram lists, or two packages implement separately.

[The foundations audit](compiler-foundations.md) sets the bar and this analysis uses it unchanged: split a flat sibling source when it owns a stable concept with a direct test; create another `compiler-*` workspace **only when that concept also needs an independent dependency or lifecycle boundary**. That audit concluded "No new workspace follows from this review", and for the packages it examined that was right. It was written before the operator, binding-provenance and nullability work multiplied the refusal surface, and the evidence below is mostly newer than it.

## The evidence that a cell is missing

Counting every backend refusal in both emitters:

```text
77  original refusals across compiler-backend-hx and compiler-backend-rs
62  of them named a "lowering" that had to happen somewhere
 1  verified backend-elected pass now owns the first shared control-flow transform
```

The refusal text told the repository what was missing. `compiler-lowering` now owns the first shared transform, C-style `for` normalization, while async, option-aware control flow, call-site, and structural-copy lowering remain absent. A remaining backend refusal still points to a concrete pass or target decision that has not been built.

## Missing cell 1 — a lowering pass library the backends call

**The strongest case, and the one that unblocks the most.** Sorting the 62 refusals by whether the work is genuinely target-specific:

| neutral — the same transformation for any target | target-specific                              |
| ------------------------------------------------ | -------------------------------------------- |
| C-style `for` → `while`                          | Rust ownership                               |
| switch fallthrough → explicit control flow       | Rust trait lowering                          |
| `async`/`await` → explicit suspension form       | type-directed operator semantics             |
| default parameters → prologue assignment         | Rust initialization/structural-type lowering |
| destructuring → explicit bindings                |                                              |
| spread and object spread → structural copy       |                                              |

Desugaring a C-style `for` into a `while` is not a Haxe question or a Rust question — neither language has a C-style `for`, and both emitters refuse it separately today.

### It is a library, not a pipeline

The passes are **an API a backend calls, not a stage that runs before it.** Whether a feature should be lowered is a backend decision, and the same feature can be right to unwrap for one target and wrong for another.

`async`/`await` is the clearest case. Converting an async function into an explicit suspension form is a well-defined transformation that does not depend on the target, so it belongs here and should be written once. But Haxe has no `await` and needs the transformation, while Rust has native `async fn` — hand it a pre-unwrapped state machine and you have thrown away the ability to emit idiomatic Rust and given `rustc` a worse version of a machine it builds better itself. The pass exists once; each backend elects it.

The same shape applies to type mapping. A backend may decide to map an external dependency **directly** to a native type — Haxe's `Map` to `haxe.ds.Map` — while routing others through the runtime contract (missing cell 2). That is a per-target judgement about idiom and fidelity, and the compiler should not make it centrally.

So the package owns three things:

- **The pass framework**: a pass interface (`IrModule → IrModule`), declared ordering constraints, and composition.
- **The neutral passes themselves**, each independently testable, added one at a time.
- **Pass verification**: after a pass runs, the IR still satisfies its invariants, and each pass states whether it is idempotent. A pass that produces malformed IR fails there rather than at emission, where the message would name the wrong stage.

A third category sits alongside the passes and is worth separating explicitly: **neutral analysis that annotates rather than rewrites.** Narrowing is the example — "after `if (v === undefined) return`, `v` is non-optional" is a target-independent fact, while `Null<T>` versus `Option<T>` is a target-specific representation. That is the pattern the static-facts work already established: compute the fact once, let each backend choose the shape.

### Against the test

- **Independent dependency boundary.** It depends on `compiler-types` and the semantic facts; it is depended on by both backends. It needs no filesystem, no TypeScript checker, and no target.
- **Independent lifecycle.** Passes arrive one at a time, each with its own regressions and its own golden fixtures converting from pinned refusal to pinned output. That is a different cadence from the emitters, which change when a target's idiom changes.

It also supplies the precondition the foundations audit named for splitting target lowering from target emission: _"do not split target lowering from target emission until an explicit target model exists between them."_ A pass library with a declared IR-to-IR contract is where that model becomes explicit.

**Implemented shape:** `compiler-lowering`, one pass per source file, called explicitly from each backend's elected selection. The first pass is control flow because it is the smallest transform both targets need. Orchestration does not impose it before backend selection.

## Implemented cell 2 — the target runtime contract

Both emitters previously referenced symbols without a shared contract: Rust carried a private standard-type table, while Haxe passed an unmapped named type verbatim into a `.hx` file. `compiler-runtime-contract` now owns the versioned neutral capability and external-type decision vocabulary plus exhaustive reachable-IR completeness. Flat Haxe and Rust sibling tables elect native or runtime representation independently, and an unmapped type refuses before target-name allocation or source generation.

The architecture in [AGENTS.md](../AGENTS.md) already names it, one line per target:

```text
-> Haxe ownership lowering + emitter + runtime contract
-> Rust ownership lowering + emitter + runtime contract
```

Three concepts per target; one of them is a package.

### The compiler owns the vocabulary, not the implementation

The downstream design already in use in `flight-hx` sets the right seam: the generator remaps an external type to a runtime library type — `flighthq._internal.*` — and the target repository decides whether that is a typedef onto a system type or a hand-written implementation satisfying the contract. That means **the compiler never needs to know Haxe's standard library.** It needs the contract vocabulary — the named capabilities emitted code may reference — and the per-target naming of them. How a contract is satisfied lives downstream, where the knowledge is.

Mapping is therefore backend-elective in the same way lowering is. A backend may bind an external type directly to a native one where the fidelity is exact, and route the rest through the contract where it is not. The compiler's job is to make sure every external type reachable from the inventory has _some_ decision recorded.

That changes what the failure should be. An unmapped external type is **not** a code-level emitter refusal; it is a **contract-completeness failure** — "no runtime contract entry for `Uint8Array`" — checkable before emission begins, and fixed by adding a table entry rather than by changing an emitter. That is a better failure in three ways: it fires earlier, it names the actual missing thing, and it is repaired with data.

### Expect this seam to push back

This is where the neutral model meets each target's reality, so it is where the neutral model will be told it is wrong. The three most likely sources of pressure: **aliasing and mutation semantics**, **integer width**, and **structural versus nominal typing**. When a contract cannot be satisfied idiomatically in a target, the finding belongs back in the neutral model rather than absorbed silently by a target adapter — otherwise the model quietly becomes "whatever the first target does".

Against the test, the contract's **lifecycle is genuinely independent**: its counterpart is implemented downstream, so it versions against `flight-hx` and `flight-rs` rather than against the emitter. Each downstream should declare which contract version it implements, so a compiler upgrade that adds a required symbol is detectable rather than a broken build.

**Implemented shape:** a neutral `compiler-runtime-contract` cell owns the contract vocabulary, versioning, reachability, and completeness check. Each backend's binding table remains a flat sibling inside that backend's existing cell, so target data does not invert the dependency. Runtime implementations remain downstream.

## Missing cell 3 — reporting and coverage

Three package reviews independently found the same gap: reporting is thinner than the work performed. Orchestration's report is three numbers; inventory counts exports; nothing anywhere can answer _which upstream declarations lowered, which refused, and by which rule_ — the number the migration most needs and the one no artifact produces.

Against the test, this **does not yet earn a cell.** It needs no independent dependency (it composes what orchestration already has), and its lifecycle is the pipeline's. This is orchestration under-delivering on its own domain rather than a domain without a home. It becomes a cell the day report schemas are consumed by a downstream repository and have to version independently — the same trigger as serialization.

## Missing cell 4 — the serialization boundary

Deliberately deferred, and the deferral is correct: freezing a provisional IR would be worse than not having a wire format. It is still a real absence, named in four of the ten reviews, and it is the precondition for the roadmap's oracle vectors and for any drift tracking between upstream revisions.

Against the test it passes cleanly when triggered: a wire format versions on a different clock from the model it encodes, which is the definition of an independent lifecycle. **Trigger:** the first of a downstream repository shipping patch documents, an oracle vector set, or a cross-process cache.

## Cells that should not exist

Stating these matters as much as the additions, because each is a plausible-sounding package that would be wrong here:

- **Target project layout** — Haxelib and Cargo structure. AGENTS.md assigns ecosystem concerns to the target repositories, and a package here would compete with them.
- **Runtime implementations.** The contract belongs here; the implementation is downstream by the same rule.
- **A CLI package.** A command-line entry point belongs _in_ `tool-compiler` as part of its published surface, not beside it. A separate cell would split one product across two.
- **`compiler-utils` or any generic container.** Forbidden by [the naming contract](compiler-naming.md), and rightly: a concept that cannot be named does not have a settled boundary.
- **A diagnostics-rendering cell.** Formatting a diagnostic for a human is small and has no independent lifecycle. It is a flat sibling in whichever cell owns the report.

## Are the domains suitably primitive?

Per package, against the repository's own rule that a package has one irreducible job.

**`compiler-inventory` — not primitive, and the seam is now enforced.** The clearest case in the repository. Fourteen sources, ~3,700 lines, and the boundary between _reading a workspace from a host_ and _analysing what a workspace exports_ is now carried by types: filesystem access is confined to one edge module behind a `WorkspaceSource` capability, with `gitCheckoutRevision` and `typeScriptProject` the two deliberate remaining host edges. Those are two jobs — _read a workspace from a host_ and _analyse what a workspace exports_ — and they pass the independent-dependency test in the strong direction: the analysis half needs no filesystem at all, which would make it testable from in-memory fixtures rather than from `mkdtemp` trees. **Recommendation:** split once the host-facts and exclusion work settles; not mid-flight.

**`compiler-types` — a namespace rather than a domain, and correctly so.** Eighteen unrelated contract families in one package fails a literal reading of "one irreducible job". It is right anyway: the naming contract requires every exported contract to live in one place, and the package is the dependency floor, so the cohesion is _architectural_ rather than topical. Worth stating explicitly so a future reader does not "fix" it.

**`compiler-semantic` — one domain, oversized file.** TypeScript-to-neutral lowering is genuinely one job. The 1,612-line lowering source is a file problem, not a package problem, and the `compilerIrStaticFacts` split was the right first cut. Further cuts are flat siblings by syntax family — declarations, types, expressions, statements — not workspaces.

**`compiler-backend-hx` / `compiler-backend-rs` — lowering and emission fused, deliberately.** Each is ~840 lines doing both jobs, against an architecture diagram that names them separately. The deferral is documented and its trigger is stated: an explicit target model between them. Missing cell 1 supplies that model, so this split is downstream of that work rather than an independent decision.

**`compiler-emission` — two concerns, one domain.** Path identity and name identity are different mechanisms answering one question: what may a generated thing be called. Cohesive.

**`compiler-provenance`, `compiler-patch`, `compiler-orchestration`, `tool-compiler` — primitive.** Each has one job, states it, and does not reach beyond it. `compiler-provenance` at 130 lines is the model the others are measured against.

## Recommended order

1. **Extend the runtime contract only from demonstrated reachability.** The external-type vocabulary, completeness check, and target tables are complete. Ambient runtime values, constructors, and static members are the next boundary when corpus evidence requires them.
2. **Add neutral lowering passes one demonstrated refusal family at a time.** The pass lifecycle is now proven by C-style control flow; it does not justify a mandatory pre-backend pipeline or speculative transforms.
3. **Decide whether `compiler-inventory` splits.** The host-access inversion AGENTS.md requires is done — one edge module, every analysis function taking a `WorkspaceSource` — so the boundary is enforced by types rather than asserted, and the split is now a mechanical move rather than a design question. It may also prove unnecessary, which is the cheaper outcome. The inversion's justification was the stated rule and the seam, **not** speed: the temp-directory tests cost 45ms, while every slow test in the package is one that constructs a TypeScript program, which the inversion does not touch.
4. **Reporting**, as orchestration's own domain rather than a new cell, until a downstream consumer forces the versioning question.
5. **Serialization**, on its stated trigger.
