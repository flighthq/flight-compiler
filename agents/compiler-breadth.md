# Compiler Breadth Analysis

A companion to [the package reviews](packages/index.md). Those ask how completely each existing package expresses its domain. This asks the two questions they cannot: **are there domains with no package at all**, and **is the decomposition itself right** — does each package own one irreducible job.

## Method, and the test a new cell has to pass

A missing cell is not "a concept we could name". It is a concept the repository **already names and cannot place**: something the refusals point at, the architecture diagram lists, or two packages implement separately.

[The foundations audit](compiler-foundations.md) sets the bar and this analysis uses it unchanged: split a flat sibling source when it owns a stable concept with a direct test; create another `compiler-*` workspace **only when that concept also needs an independent dependency or lifecycle boundary**. That audit concluded "No new workspace follows from this review", and for the packages it examined that was right. It was written before the operator, binding-provenance and nullability work multiplied the refusal surface, and the evidence below is mostly newer than it.

## The evidence that a cell is missing

Counting every backend refusal in both emitters:

```text
77  total refusals across compiler-backend-hx and compiler-backend-rs
62  of them name a "lowering" that must happen somewhere
 0  of those lowerings have a package
```

The refusal text is the repository telling itself what is missing. `requires control-flow lowering before Haxe emission`, `requires the Haxe async-lowering pass`, `requires Option-aware Rust control-flow lowering`, `requires call-site lowering`, `requires structural-copy lowering` — each names a transformation, none of them exists, and there is nowhere for one to live. A backend refuses and points at a stage that was never built.

## Missing cell 1 — neutral lowering passes

**The strongest case, and the one that unblocks the most.** Sorting the 62 by whether the work is target-specific:

| neutral — same work for both targets            | target-specific                              |
| ----------------------------------------------- | -------------------------------------------- |
| C-style `for` → `while`                         | Rust ownership                               |
| switch fallthrough → explicit control flow      | Rust trait lowering                          |
| `async`/`await` → task form                     | type-directed operator semantics             |
| nullability and narrowing → explicit optional   | Rust initialization/structural-type lowering |
| default parameters → call-site or body prologue |                                              |
| spread and object spread → structural copy      |                                              |
| destructuring → explicit bindings               |                                              |

The left column is one body of work that both backends currently refuse independently and neither performs. Desugaring a C-style `for` into a `while` is not a Haxe question or a Rust question; it is an IR-to-IR transformation that should happen once, before either emitter sees the module.

Against the test:

- **Independent dependency boundary.** It depends on `compiler-types` and the semantic facts; it is depended on by both backends and by orchestration. It does not need the filesystem, the TypeScript checker, or either target.
- **Independent lifecycle.** Passes arrive one at a time, each with its own regression set and its own golden fixtures converting from pinned refusal to pinned output. That is a different cadence from the emitters.

It also supplies precisely the thing the foundations audit named as the precondition for splitting target lowering from target emission: _"do not split target lowering from target emission until an explicit target model exists between them."_ A neutral lowering stage is where that model becomes explicit.

**Recommended name and shape:** `compiler-lowering`, one pass per source file, each `IrModule → IrModule`, each independently testable, composed in a stated order by orchestration. It starts nearly empty and grows one pass at a time; the first pass to move is control flow, because it is the smallest and both backends refuse it identically.

## Missing cell 2 — the target runtime contract

Both emitters already reference symbols that exist nowhere:

- `FlightTask`, `FlightCallback`, and the opaque host value in Rust
- the Haxe standard-library surface, which has **no mapping at all**, so an unmapped named type is emitted verbatim into a `.hx` file

That last one is the largest silent-wrong-output surface left in the repository. Unlike an operator, an unknown _type_ name does not refuse: `Promise`, `Uint8Array` and `Map` reach a Haxe file as themselves. The Rust backend has a private `rustStandardType` table, so the same domain is half-implemented in one emitter and absent from the other — which is the classic signal of a missing shared cell.

The architecture in [AGENTS.md](../AGENTS.md) already lists it, one line per target:

```text
-> Haxe ownership lowering + emitter + runtime contract
-> Rust ownership lowering + emitter + runtime contract
```

Three concepts per target; one of them is a package.

Against the test: the contract's **lifecycle is genuinely independent**, because its counterpart is implemented downstream in `flight-hx` and `flight-rs`. A version of this compiler declares "emitted code may reference these symbols with these shapes"; a downstream runtime satisfies it. That pairing has to be versioned separately from the emitter, which is exactly the boundary the test asks for.

**Recommended shape:** a neutral `compiler-runtime-contract` cell owning the contract vocabulary and its versioning, with the per-target mapping tables living as flat siblings inside each existing backend cell — the tables are target data, not a shared domain, and moving them out would create a dependency inversion.

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

**`compiler-inventory` — not primitive.** The clearest case in the repository. Twelve sources, ~3,500 lines, and the seam is already visible in the source: four sources do pure analysis with zero host imports (`flightPackageExclusion`, `flightPackageExportLane`, `flightPackageHostFacts`, `typeScriptRuntimeBinding`) while six read the filesystem, spawn `git`, or build a TypeScript program. Those are two jobs — _read a workspace from a host_ and _analyse what a workspace exports_ — and they pass the independent-dependency test in the strong direction: the analysis half needs no filesystem at all, which would make it testable from in-memory fixtures rather than from `mkdtemp` trees. That is also the package with the slowest tests in the repository, for exactly this reason. **Recommendation:** split once the host-facts and exclusion work settles; not mid-flight.

**`compiler-types` — a namespace rather than a domain, and correctly so.** Eighteen unrelated contract families in one package fails a literal reading of "one irreducible job". It is right anyway: the naming contract requires every exported contract to live in one place, and the package is the dependency floor, so the cohesion is _architectural_ rather than topical. Worth stating explicitly so a future reader does not "fix" it.

**`compiler-semantic` — one domain, oversized file.** TypeScript-to-neutral lowering is genuinely one job. The 1,612-line lowering source is a file problem, not a package problem, and the `compilerIrStaticFacts` split was the right first cut. Further cuts are flat siblings by syntax family — declarations, types, expressions, statements — not workspaces.

**`compiler-backend-hx` / `compiler-backend-rs` — lowering and emission fused, deliberately.** Each is ~840 lines doing both jobs, against an architecture diagram that names them separately. The deferral is documented and its trigger is stated: an explicit target model between them. Missing cell 1 supplies that model, so this split is downstream of that work rather than an independent decision.

**`compiler-emission` — two concerns, one domain.** Path identity and name identity are different mechanisms answering one question: what may a generated thing be called. Cohesive.

**`compiler-provenance`, `compiler-patch`, `compiler-orchestration`, `tool-compiler` — primitive.** Each has one job, states it, and does not reach beyond it. `compiler-provenance` at 130 lines is the model the others are measured against.

## Recommended order

1. **`compiler-lowering`**, starting with control-flow desugaring. It unblocks the most refusals, is the same work for both targets, and supplies the target model the backend split is waiting on.
2. **The runtime contract and the Haxe standard-library mapping.** Closes the largest silent-wrong-output surface in the repository — an unmapped type name currently emits verbatim rather than refusing. The refusal is worth adding even before the mapping exists.
3. **Split `compiler-inventory`** along the host-access seam once host facts settle.
4. **Reporting**, as orchestration's own domain rather than a new cell, until a downstream consumer forces the versioning question.
5. **Serialization**, on its stated trigger.
