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
- **Determinism independent of host**: filesystem order, locale, case-sensitivity and path separators cannot change the output. Largely present.
- **Incrementality**: re-analysing an unchanged checkout is cheap, keyed on file identity, because this is the slowest thing the compiler does.
- **Diffability**: two inventories of two revisions produce a structured difference — added, removed, changed exports — which is how a port tracks upstream drift.

## Present capabilities

- **Export-star graph with a fixed point.** Cyclic barrels converge and every lane over the same graph reports the same set. This was a real defect earlier: the first implementation cached partially-resolved results under an active cycle, so `./b` reported one export where it genuinely re-exported two, and which lane was short-changed depended on resolution order. Now lane-order independent, and I verified it.
- **Ambiguous star exports reported and omitted.** Two files exporting the same name through one barrel produce an `ExportConflict` and the name is excluded, matching ESM. Previously the conflict machinery was structurally unreachable — `resolveExports` returned a name-keyed map, so the deduplication step could never see a duplicate and `exportConflicts` was always zero. Now it fires.
- **Cross-package resolution through export maps.** A `@flighthq/pkg/subpath` import resolves via the target package's declared lane rather than a guessed `src/subpath`, so a lane whose `types` target does not mirror its subpath still resolves.
- **Runtime binding classification.** Const enums under `preserveConstEnums`/`isolatedModules`, ambient declarations, alias resolution and explicit `export type` are each handled, and the record carries the binding's own fingerprint when it differs from the export's.
- **Failure identity.** `compilerInventoryFailure.ts` gives the package tagged failures with codes and guards rather than bare `Error`s, matching the house contract.
- **Exclusions, host facts and host endpoints** are modelled as their own primitives with colocated tests, which is the right decomposition even though the content is early.
- **Portable, deterministic output.** Sorted package, lane and export lists; relative POSIX paths; no absolute host paths; explicit code-unit ordering after the locale-ordering pass, so a host locale cannot reorder a report.
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
