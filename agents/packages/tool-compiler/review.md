---
package: '@flighthq/tool-compiler'
status: solid
score: 62
updated: 2026-08-20
ingested:
  - source
  - api/tool-compiler.api.md
  - agents/compiler-migration-roadmap.md
---

# tool-compiler — Review

The only public workspace: a nine-line barrel re-exporting the nine private packages, plus its facade test. Everything a consumer can reach passes through this file, and the assembled `dist/` it produces is the sole publishable artifact.

## Verdict

**solid — 62/100.** As an assembly boundary it works and is well guarded: the packed tarball installs into a clean project and compiles a module end to end, no private package specifier leaks into shipped JavaScript or declarations, and every export is recorded in a committed API report that fails the build when it drifts. The score is held down by what a _published compiler package_ owes its consumers and does not yet provide — no entry point above the primitives, no configuration contract, no CLI, and a surface of 119 exports that is closer to "everything the packages export" than to a cultivated API.

## What a fully expressed public-compiler-package domain looks like

- **A task-level entry point.** A consumer should be able to say "compile this checkout for this target into this directory" in one call, not assemble a program, lower sources, choose a backend and write files themselves.
- **A configuration contract**: a declarative, validated description of a compilation — upstream directory, target, output root, patches, options — that can be written in a file and version-checked.
- **A CLI.** Target repositories run compilers from build scripts; a library-only surface forces every consumer to write the same wrapper.
- **A cultivated API, small on purpose.** The public surface is a promise. Primitives belong in it when a consumer genuinely composes them, not because they happen to be exported internally.
- **Stability and versioning policy**: semantic versioning applied to the emitted-output contract as well as the type surface, with a statement of what a major bump means for generated code.
- **Documentation with worked examples** for each supported task, and a migration note per breaking change.
- **Provenance in the artifact**: the package reports its own version and the compiler contract version it implements, so generated output can name what produced it.
- **A supported-input statement**: which TypeScript versions, which Node versions, which workspace shapes.

## Present capabilities

- **A real assembly, proven from outside.** `npm run smoke` packs the tarball, installs it into a temporary project with nothing else present, and compiles a module through both backends via the published entry. That is a stronger claim than importing the built module in place, where every private workspace is still on disk.
- **No private specifier leakage.** `pack:check` walks every shipped `.js` and `.d.ts` and rejects any `@flighthq/compiler-` reference or retained `.ts` import specifier, so installing the public package never requires an unpublished one.
- **The surface is recorded and gated.** `api/tool-compiler.api.md` lists all 119 exports with their kinds; `api:check` fails naming what entered or left. A type reaching the public API as a side effect of an internal edit is now a reviewable diff.
- **Zero exported runtime constants.** The API report shows 119 exports as functions and types with no values — independent confirmation that the naming contract's ban on exported runtime constants is holding.
- **Explicit barrels underneath.** Each package's `index.ts` re-exports by name, so a new internal function does not reach the public surface until someone adds it deliberately. The facade is a list of nine `export *` lines over nine cultivated lists.
- **Facade coverage.** `toolCompilerFacade.test.ts` compiles a module through both backends via the public names, so the barrel is exercised rather than merely typechecked.
- **Manifest hygiene enforced.** Name, version, author, license, repository directory, `sideEffects`, `files` and the `exports` map are all checked by `packages:check`, and the published `LICENSE.md` must match the root.

## Gaps

- **No task-level API.** Everything exported is a primitive: parse a source, lower a source, construct a backend, compile modules. A consumer wanting "compile this Flight checkout to Haxe" must construct the TypeScript program, walk the inventory, lower each source and drive the backend — which is precisely the code every downstream repository will now write independently, and which belongs here once.
- **No configuration contract.** There is no declarative compilation description and therefore no config file, no validation and no versioning of one.
- **No CLI.** `flight-hx` and `flight-rs` will invoke this from build scripts. Today that means each writes a Node wrapper.
- **119 exports is not yet a cultivated surface.** It is the union of nine package barrels. Some of it is genuinely compositional; a good deal — the internal contract families, the identity primitives, the failure constructors — is exported because it is exported internally. A reference version would decide, per name, whether a consumer composes it.
- **No versioning or stability policy.** Version is `0.0.0` and nothing states what a breaking change means for _emitted output_, which is the contract downstream repositories actually depend on. Output stability and API stability are different promises and neither is written down.
- **No supported-input statement.** `typescript` is a hard dependency pinned to one version, and the fingerprint scheme currently embeds that version, so which TypeScript versions a consumer may use is both undocumented and unusually load-bearing.
- **No self-reported provenance.** Emitted files carry a fixed header string; nothing lets a consumer ask the package which version produced an artifact.
- **README is thin against the surface.** It documents `analyzeFlightWorkspace` and the development commands; the compile path a consumer most needs has no worked example.
- **The public package is not published.** Drop-in condition four — installs into a clean consumer — is met and verified; conditions one through six as a whole are not, and the release workflow that would ship it has never run.

## Reviewer follow-up

The surface was 119 exports when this review was written. It is 191 now — 136 types and 55 functions — a 60% increase across the semantic batches, the new lowering package, and the inventory capability contracts, with no consumer added and no per-name decision made about any of them. The facade is ten `export *` lines, so every name a package barrel gains is published by default; `api:check` faithfully records the growth without ever asking whether it was intended. The gap below is therefore not a stable observation about a fixed surface — the surface is growing at roughly the rate the compiler is, and the cultivation debt grows with it. `compiler-lowering`'s own review already flags that it exposes a concrete pass and a generic runner before any downstream consumer exercises them.
