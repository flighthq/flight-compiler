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
- **Pass verification**: after a pass runs, shared structural validation and its pass-specific postcondition hold, and each pass states whether it is idempotent. Reapplication is an explicit audit depth rather than an unconditional backend cost. A pass that produces malformed IR fails there rather than at emission, where the message would name the wrong stage.

A third category sits alongside the passes and is worth separating explicitly: **neutral analysis that annotates rather than rewrites.** Narrowing is the example — "after `if (v === undefined) return`, `v` is non-optional" is a target-independent fact, while `Null<T>` versus `Option<T>` is a target-specific representation. That is the pattern the static-facts work already established: compute the fact once, let each backend choose the shape.

### Against the test

- **Independent dependency boundary.** It depends on `compiler-types` and `compiler-ir-validation`; it is depended on by both backends. It needs no filesystem, no TypeScript checker, and no target.
- **Independent lifecycle.** Passes arrive one at a time, each with its own regressions and its own golden fixtures converting from pinned refusal to pinned output. That is a different cadence from the emitters, which change when a target's idiom changes.

It also supplies the precondition the foundations audit named for splitting target lowering from target emission: _"do not split target lowering from target emission until an explicit target model exists between them."_ A pass library with a declared IR-to-IR contract is where that model becomes explicit.

**Implemented shape:** `compiler-lowering`, one pass per source file, called explicitly from each backend's elected selection. The first pass is control flow because it is the smallest transform both targets need. Orchestration does not impose it before backend selection.

## Implemented cell 2 — the target runtime contract

Both emitters previously referenced symbols without a shared contract: Rust carried a private standard-type table, while Haxe passed unmapped ambient names into output. `compiler-runtime-contract` now owns the versioned neutral capability and type/value-space ambient-symbol vocabulary plus exhaustive reachable-IR completeness. Flat Haxe and Rust sibling tables elect native or runtime representation independently, and an unmapped symbol refuses before target-name allocation or source generation.

The architecture in [AGENTS.md](../AGENTS.md) already names it, one line per target:

```text
-> Haxe ownership lowering + emitter + runtime contract
-> Rust ownership lowering + emitter + runtime contract
```

Three concepts per target; one of them is a package.

### The compiler owns the vocabulary, not the implementation

The downstream design already in use in `flight-hx` sets the right seam: the generator remaps an external type to a runtime library type — `flighthq._internal.*` — and the target repository decides whether that is a typedef onto a system type or a hand-written implementation satisfying the contract. That means **the compiler never needs to know Haxe's standard library.** It needs the contract vocabulary — the named capabilities emitted code may reference — and the per-target naming of them. How a contract is satisfied lives downstream, where the knowledge is.

Mapping is therefore backend-elective in the same way lowering is. A backend may bind an ambient type or value directly to a native symbol where the fidelity is exact, and route the rest through the contract where it is not. Type and value space are separate decisions: a target may support a type without claiming its constructor or static API. The compiler's job is to make sure every reachable ambient symbol has _some_ decision recorded.

That changes what the failure should be. An unmapped ambient symbol is **not** a code-level emitter refusal; it is a **contract-completeness failure** — for example, `Uint8Array[value]` — checkable before emission begins, and fixed by adding a justified table entry rather than by changing an emitter. That is a better failure in three ways: it fires earlier, it names the exact missing space, and it is repaired with data.

### Expect this seam to push back

This is where the neutral model meets each target's reality, so it is where the neutral model will be told it is wrong. The three most likely sources of pressure: **aliasing and mutation semantics**, **integer width**, and **structural versus nominal typing**. When a contract cannot be satisfied idiomatically in a target, the finding belongs back in the neutral model rather than absorbed silently by a target adapter — otherwise the model quietly becomes "whatever the first target does".

Against the test, the contract's **lifecycle is genuinely independent**: its counterpart is implemented downstream, so it versions against `flight-hx` and `flight-rs` rather than against the emitter. Each downstream should declare which contract version it implements, so a compiler upgrade that adds a required symbol is detectable rather than a broken build.

**Implemented shape:** a neutral `compiler-runtime-contract` cell owns the contract vocabulary, versioning, reachability, and completeness checks. Symbol representation remains under `flight-runtime-contract/2`; direct ambient construction has an independent `flight-runtime-constructor-abi/1` lifecycle that records exact fixed arities and whether dynamic spreads are supported. Each backend's symbol and constructor tables remain flat siblings inside that backend's existing cell, so target data does not invert the dependency. Runtime implementations remain downstream.

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
- **`compiler-utils` or any generic container.** Forbidden by [the naming contract](compiler-naming.md), and rightly: a concept that cannot be named does not have a settled boundary. This is not an argument against the canonical-form cell below, and I first misread it as one: that concept is named, and named by this repository's own determinism rules. The container this bans is the one defined by what is left over, not by what it owns.
- **A diagnostics-rendering cell.** Formatting a diagnostic for a human is small and has no independent lifecycle. It is a flat sibling in whichever cell owns the report.

## Are the domains suitably primitive?

Per package, against the repository's own rule that a package has one irreducible job.

**`compiler-inventory` — not primitive, and the seam is now enforced.** The clearest case in the repository. Fourteen sources, ~3,700 lines, and the boundary between _reading a workspace from a host_ and _analysing what a workspace exports_ is now carried by types: filesystem access is confined to one edge module behind a `WorkspaceSource` capability, with `gitCheckoutRevision` and `typeScriptProject` the two deliberate remaining host edges. Those are two jobs — _read a workspace from a host_ and _analyse what a workspace exports_ — and they pass the independent-dependency test in the strong direction: the analysis half needs no filesystem at all, which would make it testable from in-memory fixtures rather than from `mkdtemp` trees. **Recommendation:** split once the host-facts and exclusion work settles; not mid-flight.

**`compiler-types` — a namespace rather than a domain, and correctly so.** Eighteen unrelated contract families in one package fails a literal reading of "one irreducible job". It is right anyway: the naming contract requires every exported contract to live in one place, and the package is the dependency floor, so the cohesion is _architectural_ rather than topical. Worth stating explicitly so a future reader does not "fix" it.

**`compiler-semantic` — one domain, oversized file.** TypeScript-to-neutral lowering is genuinely one job. The 1,612-line lowering source is a file problem, not a package problem, and the `compilerIrStaticFacts` split was the right first cut. Further cuts are flat siblings by syntax family — declarations, types, expressions, statements — not workspaces.

**`compiler-backend-hx` / `compiler-backend-rs` — lowering and emission fused, deliberately.** Each is ~840 lines doing both jobs, against an architecture diagram that names them separately. The deferral is documented and its trigger is stated: an explicit target model between them. Missing cell 1 supplies that model, so this split is downstream of that work rather than an independent decision.

**`compiler-emission` — three concerns, one lifecycle.** Path identity, target-name identity, and generated source contents are different mechanisms answering one portable-output question: what may a backend hand to the target repository. Content normalization, UTF-8 encoding, and generated-file provenance close at the same boundary as portable file names; none has an independent consumer or dependency direction. Cohesive.

**`compiler-provenance`, `compiler-patch`, `compiler-orchestration`, `tool-compiler` — primitive.** Each has one job, states it, and does not reach beyond it. `compiler-provenance` at 130 lines is the model the others are measured against.

## Missing cell 5 — canonical form

`function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }` appears **eleven times** across four packages — emission, patch, orchestration, and seven files in inventory — byte-identical in every copy. It is not a convenience wrapper; it is the definition of deterministic ordering for this compiler, and determinism is a stated invariant rather than a style preference.

Three things follow from eleven copies:

- **The ordering decision is invisible.** `left < right` is UTF-16 code-unit order, which is the correct choice precisely because it is locale-independent — and nothing anywhere says so. A future contributor "fixing" one copy to `localeCompare` would make one package's output locale-dependent, and the other ten would disagree with it.
- **It generates systematic mutation noise.** Every copy sorts values that are unique by construction, so its equality arm is unreachable and each copy contributes two permanent survivors. Eleven copies, twenty-two survivors that no test can kill, spread across four packages' reports forever.
- **A shared primitive would be tested once, including the equality arm** that no current caller can reach but a correct total comparator must have.

`compareText` is not the whole of it, and looking only at it is what made my first reading of this wrong. The same shape holds for **portable path form**, which is implemented ten times across five packages — in two spellings that disagree:

- `value.split(path.sep).join('/')` in five `compiler-inventory` sources and in `compiler-semantic`. This is **host-dependent**: on POSIX `path.sep` is `/`, so a path segment containing a literal backslash is left exactly as it was.
- `sourcePath.replaceAll('\\', '/')` in `compiler-emission`, in both backends' identity modules, and in `compiler-inventory`'s own `memoryWorkspaceSource.ts`. This is **host-independent**: a backslash always becomes a separator.

The split runs _through_ `compiler-inventory` rather than between packages: one file there disagrees with its five siblings. I wrote that file, and did not notice I was choosing a spelling.

Feed both the same manifest path containing a backslash on a POSIX host and they produce different answers, so one file has two canonical identities depending on which package looked at it — and the disagreement is a function of the host. That is the exact property the modeling rules forbid ("deterministic outputs contain no ... machine-specific absolute paths") and that the foundations bar names ("callers cannot observe accidental mutation or host-platform differences"). The triggering input is unusual enough that this is a latent identity hazard rather than a live defect today, but nothing in the repository would catch it becoming one. Add Unicode canonical form (`normalize('NFC')`, twice in emission) and content normalization (CRLF collapse and single-final-newline, in emission), and the surface is three primitive families spread across six packages.

### Why this is a cell and not `compiler-utils`

The naming contract rightly forbids a generic container, and the test it applies is whether the concept can be **named**. This one is already named, repeatedly, by the repository itself: the modeling rules state the determinism invariant, and the foundations bar makes host-independence part of maturity. The domain is _canonical form_ — the rules that make two runs, two machines, and two operating systems agree on the same bytes. That is a settled boundary, not a leftovers drawer.

It also passes the second half of the bar, which is the decisive part. A new workspace is warranted only when the concept **needs an independent dependency or lifecycle boundary**, and this one needs the strictest boundary in the repository: **zero dependencies**. That requirement is precisely why the code is duplicated rather than shared today:

- `compiler-provenance` is the right home by domain, but it declares `typescript` — and it needs to, being a single source that fingerprints TypeScript syntax. `compiler-emission` and `compiler-patch` depend on `@flighthq/compiler-types` alone, deliberately. Routing a one-line comparator through provenance would pull TypeScript into the floor of two packages that have kept it out.
- `compiler-types` cannot hold it: it is the type-only contract workspace and the facade re-exports it with `export type *`, so no runtime function can live there.

There is no floor below `compiler-types` that carries runtime code, and that absence is the reason for every copy. On mass, the cell would own more than `compiler-provenance` does — provenance is one source file and is a legitimate cell — so "thin placeholder" does not apply either.

### What it would own, and what it would not

Only what the duplication evidence actually supports: **deterministic text order** (11 copies across four packages) and **portable path form** (10 sites across five, in two disagreeing spellings, where the move also decides the host-dependence). Nothing target-specific, nothing that reads a checkout.

Deliberately _not_ moved on day one: Unicode canonical form is two copies inside `compiler-emission`, and content normalization is one. Neither meets the bar this analysis applies to everything else — two packages implementing it separately — so both stay where they are until a second package needs them. An earlier draft of this section listed them as cell contents, which would have made the package partly speculative. The canonical serialization boundary joins it when it exists, not before.

### Naming

One package, not several: **`compiler-canonical-form`**, published as `@flighthq/compiler-canonical-form`. Text order and path form share one dependency boundary (zero) and one lifecycle, and splitting primitives that are already irreducible is exactly the overhead the composition rules warn about.

Rejected, with reasons, because the name is the part most likely to go wrong here:

- `compiler-utils`, `compiler-common`, `compiler-shared` — banned by the naming contract, and `common`, `util`, `utils`, and `shared` are literally in `genericSourceConcepts` in the health gate.
- `compiler-determinism` — overclaims. Determinism is a property the whole compiler owes; a package cannot own it.
- `compiler-normalization` — collides with `compiler-provenance`, which already owns normalizing TypeScript source for fingerprints and exports `normalizeTypeScriptNode`.
- `compiler-identity` — same collision, from the other direction.
- `compiler-collation` — names only the ordering half.
- `compiler-text` — names a data type rather than a domain.

Sources, both verb-free concept nouns with no basename collision anywhere under `packages/`, and neither beginning with a verb the file-name gate rejects:

- `canonicalTextOrder.ts` — `getCanonicalTextOrder(left, right): number`. Not `compareCanonicalText`: `compare` is **not** in the approved verb list the gate enforces (`analyze|apply|collect|combine|compile|convert|create|define|emit|fingerprint|get|has|indent|is|lower|normalize|parse|read|resolve|validate`), so that name fails `packages:check`. `get` is approved, the style rules already assign `get*` to accessors, and `values.sort(getCanonicalTextOrder)` reads correctly at the call site. Adding `compare` to the verb list is the alternative, and worth it only if a comparator family grows beyond one.
- `portableSourcePath.ts` — `convertSourcePathToPortableForm(value): string`, mirroring the existing `convertSourcePathToHaxeModuleName` precedent. This is where the two spellings are reconciled, and it must adopt the host-independent one, since host-dependence is the defect rather than an incidental difference.

No new contract types: both signatures are strings and a number, so `compiler-types` is untouched.

One honest cost. `packageHealth` requires every private workspace to appear in the public facade — `checkSet('public facade', 'workspace exports', …)` compares the facade's exports against the full package list — so these two functions become published API the day the package exists, taking the surface from 191 to 193. That is the automatic publication flagged in the `tool-compiler` review, arriving again. It does not block the cell, but it is an argument for the facade-completeness rule gaining a considered exception rather than a further argument against the package.

The drift has already started: `hostWorkspaceSource.test.ts` sorts with `localeCompare` while all eleven production copies sort by code unit. It is only a test's assertion order today, and it is the first spelling of a rule that exists in eleven places and is written down in none.

## Recommended order

1. **Extend the runtime contract only from demonstrated reachability.** Ambient type and value identities, completeness, constructors, static members, and target tables are explicit. Primitive `symbol`, callback, and opaque-host capabilities remain outside completeness until a target path demonstrates their required identity.
2. **Add neutral lowering passes one demonstrated refusal family at a time.** The pass lifecycle is now proven by C-style control flow; it does not justify a mandatory pre-backend pipeline or speculative transforms.
3. **Decide whether `compiler-inventory` splits.** The host-access inversion AGENTS.md requires is done — one edge module, every analysis function taking a `WorkspaceSource` — so the boundary is enforced by types rather than asserted, and the split is now a mechanical move rather than a design question. It may also prove unnecessary, which is the cheaper outcome. The inversion's justification was the stated rule and the seam, **not** speed: the temp-directory tests cost 45ms, while every slow test in the package is one that constructs a TypeScript program, which the inversion does not touch.
4. **Reporting**, as orchestration's own domain rather than a new cell, until a downstream consumer forces the versioning question.
5. **Serialization**, on its stated trigger.
