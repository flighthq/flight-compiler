---
package: '@flighthq/compiler-inventory'
status: solid
score: 68
updated: 2026-08-20
ingested:
  - source
  - agents/compiler-foundations.md
  - agents/compiler-migration-roadmap.md
---

# compiler-inventory — Review

The largest package: 12 implementation sources and ~3,500 lines covering package discovery, manifests, export lanes, the export-star graph, exclusions, host facts, TypeScript host endpoints, runtime-value classification, project construction and checkout revision. It is the first composition above the dependency floor and the only package that reads a filesystem.

## Verdict

**solid — 68/100.** The export-lane and export-star work is the best-tested analysis in the repository: the graph converges to a fixed point, ambiguous star exports are reported _and_ omitted rather than resolved by traversal order, and cross-package edges route through declared export maps rather than a guessed `src/` layout. I probed all three and they hold. The score reflects breadth rather than quality — the roadmap puts this domain at 50–60% and that matches what I see: the shape of a Flight workspace is well modelled, but the _facts_ a target port needs about it are only partly gathered, and every entry point is a full cold read.

## What a fully expressed workspace-inventory domain looks like

- **Complete manifest comprehension**: every export condition, subpath pattern, wildcard, `imports` map, and the resolution rules a real runtime applies — not a curated subset that fails loudly outside it.
- **A correct module graph**: re-export chains, cyclic barrels resolved to a fixed point, ambiguous star exports treated as ESM treats them, type-only propagation, and default/namespace re-exports. Largely present.
- **Runtime-versus-type classification** that matches what the TypeScript emitter would actually do, including const enums under each flag combination, ambient declarations, and alias chains. Present.
- **Host and platform facts**: which packages touch the host, which endpoints they call, what capability each implies, and what a target must provide to satisfy them. Partly present and new.
- **Exclusion and inclusion rules** that explain themselves: what is out of the port and _why_, sourced from declaration rather than inference. Present in first form.
- **A stable, versioned report** consumable by a downstream repository without this compiler in scope, with counts that add up and provenance for every record.
- **Determinism independent of the machine**: filesystem order, locale, case-sensitivity and path separators cannot change the output. Largely present.
- **Incrementality**: re-analysing an unchanged checkout is cheap, keyed on file identity, because this is the slowest thing the compiler does.
- **Diffability**: two inventories of two revisions produce a structured difference — added, removed, changed exports — which is how a port tracks upstream drift.

## Present capabilities

- **Export-star graph with a fixed point.** Cyclic barrels converge and every lane over the same graph reports the same set. This was a real defect earlier: the first implementation cached partially-resolved results under an active cycle, so `./b` reported one export where it genuinely re-exported two, and which lane was short-changed depended on resolution order. Now lane-order independent, and I verified it.
- **Ambiguous star exports reported and omitted.** Two files exporting the same name through one barrel produce an `ExportConflict` and the name is excluded, matching ESM. Previously the conflict machinery was structurally unreachable — `resolveExports` returned a name-keyed map, so the deduplication step could never see a duplicate and `exportConflicts` was always zero. Now it fires.
- **Cross-package resolution through export maps.** A `@flighthq/pkg/subpath` import resolves via the target package's declared lane rather than a guessed `src/subpath`, so a lane whose `types` target does not mirror its subpath still resolves.
- **Runtime binding classification.** Const enums under `preserveConstEnums`/`isolatedModules`, ambient declarations, alias resolution and explicit `export type` are each handled, and the record carries the binding's own fingerprint when it differs from the export's.
- **Failure identity.** `compilerInventoryFailure.ts` gives the package tagged failures with codes and guards rather than bare `Error`s, matching the house contract.
- **Exclusions, host facts and host endpoints** are modelled as their own primitives with colocated tests, which is the right decomposition even though the content is early.
- **Portable, deterministic output.** Sorted package, lane and export lists; relative POSIX paths; no absolute machine paths; the shared `compiler-canonical-form` primitives prevent machine path and locale differences from changing a report.
- **Checkout identity.** `gitCheckoutRevision` pins the upstream commit into the report, which is what makes an inventory comparable across runs.
- **`.tsx` handled by extension** rather than parsed as `.ts`, closing an earlier defect where JSX would silently misparse.

## Gaps

- **Manifest comprehension is a curated subset.** Conditions must include `types` and `default`; targets must match `./dist/<stem>.(d.ts|js)`; subpath patterns (`./*`), wildcards, `imports`, and nested condition objects are unhandled. Every unhandled shape fails loudly, which is correct, but the domain is "understand a package manifest" and this understands the manifests this workspace happens to use.
- **The `src/` layout is still assumed in places.** `sourceForExportTarget` maps `./dist/<stem>` to `src/<stem>.ts`. A package that builds from a different root is unrepresentable, and the mapping is a convention rather than a declared fact.
- **No incrementality, and program construction is the real cost.** Every run constructs a full TypeScript program and walks every package, and nothing is cached across runs. Measured per test under coverage instrumentation, every slow test in this package is one that builds a program — `typeScriptProject` 3.7s, `typeScriptRuntimeBinding` 3.7s/2.4s/2.4s, `typeScriptHostEndpointInventory` 3.4s/2.3s/2.3s/1.9s — while the manifest, lane and import tests that build real temporary directories cost 45ms for three tests combined. The filesystem is not the expense; loading and checking the standard library is. Five separate tests each construct their own program, so a shared fixture program would remove most of ~14s without changing a single assertion.
- **No diff.** Two inventories cannot be compared. Tracking upstream drift, which is the migration's central task, is therefore manual.
- **Host facts and endpoints are first-form.** They exist as primitives with tests, but the roadmap's "full downstream export, host, static-fact, and exclusion behavior" is explicitly the remaining 40–50% of this domain, and nothing here yet tells a target author what capability set they must implement.
- **Two parse trees for one file.** Package parsing constructs its own `SourceFile` for structural reads while the program holds another for checker work. They agree today because the text is identical; a reference version would read one tree.
- **Fingerprint granularity for variable statements.** A multi-declarator `export const a = 1, b = 2` gives both records the statement's fingerprint in the IR path; the inventory's own records now derive per-export identity, but the two paths should be stated to agree.
- **No report versioning story beyond the discriminant.** `flight-compiler-inventory/1` exists; what constitutes a breaking change to it, and what a consumer should do on a bump, is not written down.

## Reviewer follow-up — what mutation says about this package

406 mutants across fourteen files: 273 killed, 133 survived. The distribution is the finding, more than any single survivor.

The small primitives are proven. `flightPackageExportLane`, `fileSystemWorkspaceSource`, `typeScriptProject`, and `gitCheckoutRevision` have **no** survivors at all. `flightWorkspaceInventory` — 766 lines, the orchestrating analysis the whole package exists to produce — has **56 survivors out of 108 mutants**, over half. Verification quality here tracks file size and role in exactly the wrong direction: the pieces that are easy to test are tested, and the piece that decides what the compiler sees is the least checked.

Three real gaps were closed rather than filed:

- **Declaration files and colocated tests were excluded by code no test exercised.** `isSourceFile` rejects `.d.ts` and `*.test.ts`, and nothing in the fixture had either, so both exclusions were unverified. A `.d.ts` admitted as source would be analyzed as a second declaration of the same symbols; a test file admitted would be read as public API. The fixture now carries both and pins `sourceFiles`/`testFiles` against them.
- **The runtime-binding three-way agreement was unasserted.** Whether an export carries a `runtimeBinding` or drops it as redundant is decided by fingerprint, kind, and source agreeing. The fixture asserted the _carried_ case and never the dropped one, so the agreement itself was free to be wrong.
- **`bin` refusals stopped at the array case.** An empty-string `bin`, an empty bin name, an empty target, and a non-string target all reach fail-loudly paths that no test entered.

Twenty of the survivors are `compilerInventoryFailure`'s failure-code registry markers — the documented equivalent shape, not a gap. Several more are the `compareText` equality arm, once per copy; those disappear with the shared ordering primitive.

A fourth gap closed in a second pass: **an export renamed on its way out was resolved by four separate sites and exercised at none of them.** `element.propertyName?.text ?? element.name.text` appears in the import clause, the module-graph walk, the local re-export resolution, and the re-export conflict assertion. The fixture had no rename anywhere, so all four were free to read the wrong half of the alias. It now carries a name renamed twice — once by the import clause, once by the export clause — reaching the lane matching its declaring file at neither end, a second file reachable _only_ through that alias so the graph walk has to follow it, and a renamed re-export through a module specifier. Each of the four sites was then mutated individually and each failed the test.

A fifth: **the containment refusal had no test at all.** `relativeSource` refuses a program file that resolves outside the upstream checkout — the guard that keeps a source identity, and therefore a fingerprint, from being minted for a file nobody vouched for. A fixture whose package source re-exports from a sibling temporary directory now reaches it, and neutralizing the clause makes that test fail.

Three of that guard's four clauses stay uncovered on purpose, and the reason is worth recording so nobody counts them as gaps: `relative === ''` and `relative === '..'` describe the checkout root and its parent, and a program _file_ can be neither, while `path.isAbsolute(relative)` occurs only across drives on Windows. The reachable clause is the one now tested; the rest are defensive against shapes this input cannot take.

Left open deliberately, and worth naming rather than quietly skipping: roughly forty survivors remain in `flightWorkspaceInventory`, covering declaration merging and SDK-exposure boundaries. They are real questions, not equivalent mutants, and closing them is a larger piece of work than one pass.

## Reviewer note — what the portable path rule merges

`normalizePathPortable` converts every backslash to a slash, machine-independently. That is the right call: the alternative spelling it replaced was machine-dependent, and machine-dependent identity is the defect. But the rule is lossy in one direction that this package is the one to notice, because it is the package that turns real filesystem entries into source identities.

A backslash is a legal character in a POSIX filename — POSIX forbids only `/` and NUL. `normalizePathPortable` is applied to `path.relative(upstreamDirectory, file)`, so a real POSIX file named `weird\name.ts` becomes the identity `weird/name.ts`: the identity of a file in a directory that does not exist. Worse, it is a **collision** — a real `weird/name.ts` alongside it maps to the same identity, and source identity is fingerprinted and carried as provenance. Emission refuses colliding emitted paths; nothing refuses two upstream files collapsing into one identity before emission ever sees them.

Closed at the discovery edge: `createFileSystemWorkspaceSource` now refuses an entry whose own name contains a backslash, under `invalid-source-path`, before joining or normalizing. The reasoning below is why that layer is the right one.

The fix is not to restore the machine-dependent spelling. It is that a backslash inside a single **directory entry name** is unambiguous — it is part of the name, not a separator — while a backslash in a path _assembled by the machine's path API_ is a separator on Windows. Refusing a discovered entry whose own name contains a backslash, under the existing `invalid-source-path` code, keeps the determinism and removes the collision. Pathological input, legal input, and currently silent.

One thing the first fix left behind, since closed: the rule lived in one of the two implementations of `WorkspaceSource` rather than in the capability contract. `createMemoryWorkspaceSource` normalizes its keys through `normalizePathPortable`, so a key of `weird\name.ts` silently becomes `weird/name.ts` — precisely what the host source now refuses. The fake therefore accepts a workspace production rejects, which lets a fixture assert behavior on a state that cannot occur, and a third implementation — the memory source's own comment anticipates an editor or a bundler — would reintroduce the collision with nothing to stop it.

`WorkspaceSourceEntry.name` is one path segment, and "a segment contains no separator" is a property of the capability rather than of one implementation. The contract now states it, and the memory source refuses such a key rather than reinterpreting it, so both implementations answer the same way.

Both sources still normalize separators on _lookup_, so a memory workspace answers `isFile` for a backslash-spelled query that a POSIX machine would miss. That asymmetry is deliberate and unreachable from compiler code: every path reaching a lookup has already been through `normalizePathPortable`, and leniency on a query cannot create an identity, only find one that a stricter spelling would have found too.
