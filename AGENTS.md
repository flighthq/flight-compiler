# Flight Compiler Codebase Map

This repository publishes `@flighthq/tool-compiler`, the shared TypeScript compiler used to generate non-TypeScript Flight targets. Read this file in full at the start of each session. The upstream Flight SDK is the API and behavioral source of truth; this package describes it but never edits it.

This file is a codebase map, not a notebook. Put rules here only when every contributor needs them and source, tests, manifests, or generated output cannot make them obvious. Put domain detail and changing plans under `agents/`, then leave a short pointer here. `npm run docs:check` keeps this map below 40,000 characters and verifies the Claude entry point and local document links.

## Pre-Release API Philosophy

This compiler has no published consumers yet. Compatibility with a provisional local API is not a reason to preserve the wrong name, parameter order, contract, or package boundary. Correct foundational design now is cheaper than a permanent adapter later.

Treat every exported name and contract as a candidate for the final form. Names, module shape, dependency direction, determinism, ownership, and portability are design outputs, not cleanup. A package name is a promise of a coherent, mature domain; a thin placeholder is unfinished work, not an intentional architecture.

Work from the dependency floor upward. Stabilize contracts and identity before analyzers, analyzers before orchestration, and orchestration before downstream compatibility. Do not make a lower layer more abstract merely to anticipate an upper layer. A target-neutral concept must stand on its own meaning.

## Design Posture

The compiler favors explicit data and named passes over objects with hidden behavior. Reading a contract should reveal what data exists; reading a function signature should reveal what work, mutation, allocation, or I/O can happen. Imports perform no work.

Clarity is allowed to cost a few more call-site lines. Explicit analysis, lowering, patch, and emission phases are preferable to a convenient operation that silently combines them. Filesystem and process access stay at the edge and enter through explicit calls or capability records.

Use canonical compiler vocabulary. If a name requires knowledge of its directory to make sense, it is not yet a public name. Prefer an industry-recognized term when it precisely matches the concept; otherwise name the Flight-specific concept in full.

## Architecture

The invariant is one TypeScript source of truth and one compiler with a target-neutral core plus multiple target backends:

```text
Flight TypeScript checkout
  -> package/export/symbol analysis
  -> target-neutral IR and semantic patches
  -> deterministic inventory, provenance, and coverage
  -> target adapter
       -> Haxe ownership lowering + emitter + runtime contract
       -> Rust ownership lowering + emitter + runtime contract
```

Core owns TypeScript program construction, package and export-lane resolution, symbol identity, runtime/type-only classification, normalized fingerprints, source provenance, neutral IR, semantic patch identity, and shared report schemas.

This package also owns compiler orchestration, the backend contract, target-specific semantic and ownership lowering, language naming, emitted file layout, and concrete Haxe and Rust source emitters. Target-specific data belongs under its backend model and must not leak into the neutral IR.

Target repositories own ecosystem concerns: maintained runtime support, target standard-library implementations, package or crate/project structure, examples, integration tests, compiler installation, and host/oracle wiring. Compiler output may refer to an explicit runtime contract, but runtime implementation source stays downstream.

Haxe is the first integration target and defines the initial compatibility bar. Rust follows against the same neutral model and orchestration path. New core abstractions must still be genuinely target-neutral; “both current targets happen to need it” is evidence, not proof.

## Workspace Layout

The repository follows Flight's package-per-domain convention. Internal workspace names always use the `compiler-` prefix so they remain unambiguous beside standard Flight packages:

- `packages/compiler-types/`: every shared compiler contract, diagnostic shape, and target-neutral IR type.
- `packages/compiler-inventory/`: read-only package, export-lane, symbol, and runtime-value analysis.
- `packages/compiler-provenance/`: normalization, provenance, and stable fingerprints.
- `packages/compiler-semantic/`: TypeScript semantic analysis and neutral lowering.
- `packages/compiler-patch/`: fingerprinted semantic patch application and audits.
- `packages/compiler-emission/`: target-neutral backend and output infrastructure.
- `packages/compiler-backend-hx/`: Haxe-specific lowering, naming, and source emission.
- `packages/compiler-backend-rs/`: Rust-specific lowering, naming, and source emission.
- `packages/compiler-orchestration/`: deterministic pipeline composition.
- `packages/tool-compiler/`: the only public workspace and the cultivated `@flighthq/tool-compiler` facade.
- `scripts/`: repository health, isolated testing, typecheck, clean, and package-artifact gates.
- `agents/`: durable agent-facing indexes, roadmaps, migration state, and contributor conventions under `agents/conventions/`.
- `docs/`: durable architecture and migration decisions.

Every workspace keeps a flat `src/` and colocates its unit tests. Cross-package imports go through the dependency package's `src/index.js`. Internal packages are private development boundaries; the repository root is a private orchestration workspace, and its build assembles them into the single public package without leaving private package specifiers in JavaScript or declarations.

`scripts/` is repository automation, not compiler package source. Requirements stated for `packages/` do not extend to scripts: package-domain filename uniqueness, free-function-only organization, simple-primitive decomposition, centralized exported contracts, matching colocated tests, exact per-export `describe()` suites, and package coverage expectations are all explicitly inapplicable. Scripts may use task-oriented names and whatever local structure makes the automation clearest, and they need focused tests only when their risk warrants them. They remain subject to the repository's strict TypeScript, formatting, linting, documentation, build, and applicable script-specific health checks.

`compiler-types` is the type-only contract workspace, so runtime-test structure is not a package requirement there. Its source files do not need matching `.test.ts` files, exact `describe()` suites, or a minimum test count. Add compile-time composition tests only when they prove a useful assignability, inference, or exhaustiveness property; typecheck is the baseline contract gate. Naming, flat layout, centralized vocabulary, strictness, and dependency-floor requirements still apply.

A flat source tree is not a one-file rule. Split a large concern into focused sibling files within the same `src/` before creating another workspace. Add a workspace only for a distinct domain contract, dependency boundary, or lifecycle that benefits from independent health and unit-test gates.

## Composition and Bedrock

Complexity usually means a unit is hiding smaller primitives. Decompose until each package has one irreducible job, then stop. A screw, nut, bolt, or 2×4 should be simple in isolation; assemblies remain understandable because their parts are simple. Splitting an already irreducible primitive only creates naming, dependency, and lifecycle overhead.

The dependency floor is deliberate:

- `compiler-types` defines vocabulary and contracts without implementation dependencies.
- `compiler-provenance` defines deterministic normalization and identity without depending on another compiler package.
- `compiler-patch` and `compiler-emission` depend only on the contracts they operate over.
- inventory, semantic lowering, backends, and orchestration are compositions above that floor.

Before expanding a higher package, read [the compiler foundations audit](agents/compiler-foundations.md). A foundation is mature only when its boundary is narrow, its vocabulary is worth freezing, deterministic behavior is tested by equivalence and counterexample, failure values are inspectable, and callers cannot observe accidental mutation or host-platform differences.

Keep imports side-effect-free. Importing the package must not read a checkout, start work, mutate registries, or write reports. Filesystem work begins only when a caller invokes an explicit function.

## Modeling Rules

- Parse TypeScript with the TypeScript compiler API. Never infer syntax or exports with regular expressions.
- Resolve complete package export lanes and re-export chains before a target chooses what to emit.
- Preserve Flight’s free-function identities, `create<Type>` allocation boundary, explicit `out` parameters, aliasing semantics, and sentinel behavior in the neutral model.
- Every public export is lowered, patched, or represented by a structured diagnostic. Never silently drop a declaration.
- Every declaration and patch retains stable upstream identity: package name, source path, export name, and normalized SHA-256 fingerprint.
- Deterministic outputs contain no timestamps, machine-specific absolute paths, or filesystem iteration order.
- Expected environmental absence returns a structured result where the API defines one. Invalid compiler configuration, unresolved public exports, ambiguous patches, and stale fingerprints fail loudly.
- Use small free functions and plain data. Compiler packages do not define classes; tagged diagnostic values and explicit function records provide failure and capability contracts.
- Exported names must be globally understandable without relying on a deep import path for context.
- Authored TypeScript files under package `src/` use globally unique, verb-free concept-noun basenames. A test inherits its source concept with `.test.ts`; repeated package `index.ts` entry barrels are the routine exception. Generic names such as `shared`, `internal`, `utils`, and `helpers` are forbidden in packages. See [the compiler naming contract](agents/compiler-naming.md).
- Every declaration exported from a compiler package has a globally unique name. Exported package runtime APIs are named free functions using `<verb><FullType><Modifier?>`: the full operated-on type follows the verb, with a modifier only when it distinguishes the operation, result, or target. Types remain concept nouns. Target abbreviations stay in package slugs; TypeScript APIs spell Haxe and Rust in full.
- Expected failures use stable tagged data or tagged `Error` records with type guards. Error message text is for people, not control flow.
- A normalization or fingerprint function must be tested with both equivalence pairs and semantic counterexamples. Canonicalization may remove irrelevant spelling differences but must never merge distinct programs.
- Functions do not mutate caller-owned input unless mutation is the explicit contract. Clone at the boundary when a transformation needs a working copy.

## License Provenance

The root `LICENSE.md` is the operative license and copyright statement. Do not copy third-party source, fixtures, corpora, specifications, or definition files into this repository. Testing against an external checkout is allowed when it is fetched or supplied outside the repository and nothing from it is committed.

The first-party [`flighthq/flight`](https://github.com/flighthq/flight) repository is an approved source for repository scripts and documentation. Those materials may be reviewed, adapted, or copied when they improve this repository's tooling or contributor guidance; preserve relevant copyright or provenance notices and keep product-specific Flight checks out unless this compiler owns the same concern. This exception does not extend to unrelated upstream implementation code or other repositories.

Implement compiler facts and behavior in this repository's architecture; outside the approved Flight scripts/documentation exception, do not translate a reference implementation line by line. When an external artifact is needed for a reproducible check, record how to obtain it and its content hash without importing its license text or creating a new attribution obligation.

## TypeScript Style

- Use strict TypeScript, exact optional properties, and checked indexed access.
- Use `Readonly<T>` and readonly collections where mutation is not part of the contract.
- Put type-only imports on their own `import type` line.
- Keep exported functions alphabetized within a file unless pipeline order is clearer.
- Keep tests in source/API order. Each exported function needs direct behavior coverage, including its boundary and failure cases where applicable.
- Add comments only for durable invariants, ownership, identity, determinism, or compiler behavior that names cannot express.
- Do not add transient `TODO`, `FIXME`, or work-history comments to source.
- Keep loose constants and implementation state after exported functions so the public surface scans first.
- Boolean queries use `is*` or `has*`; accessors use `get*`; allocating operations use `create*` and make the allocated type explicit.
- Keep commits to one Conventional Commit subject with no body or trailers. See [the commit conventions](agents/conventions/commits.md); the `commit-msg` hook enforces the checkable parts.

## Commands

Use npm, not pnpm or Yarn. Node.js 22 or newer is required. Script names follow [the npm script naming grammar](agents/conventions/npm-scripts.md), where `:check` is the non-writing mode of a verb rather than a subject.

- `npm run fix`: apply Oxlint fixes and Oxfmt formatting after edits.
- `npm run check`: complete deterministic gate; run before handoff. Every registered gate runs even after an earlier one fails, and the failures are reported together.
- `npm run test`: run Vitest once.
- `npm run test:packages`: run every private package and the public package in isolation.
- `npm run test:coverage`: run all unit tests together with aggregate instrumentation. The complete gate intentionally runs tests once in isolation and again for coverage because these lanes prove different properties.
- `npm run docs:check`: enforce the bounded codebase map, Claude pointer, local documentation links, and `npm run` citations that name a real script.
- `npm run exports:check`: outside `compiler-types`, require one exactly named colocated test file for every non-barrel package source and one exact `describe('<function>')` block for every exported function. This proves test structure and naming, not assertion depth.
- `npm run typecheck`: run the root and every workspace's strict no-emit check, collecting failures.
- `npm run packages:check`: enforce manifests, flat source trees, dependency declarations and acyclicity, centralized contracts, class-free implementation, globally unique domain filenames and APIs, verb-first function names, transient-comment absence, tests, and public-facade completeness.
- `npm run build`: clean stale output and assemble ESM JavaScript, declarations, maps, and declaration maps in `packages/tool-compiler/dist/`.
- `npm run pack:check`: build fresh, inspect the publishable tarball, and prove every private workspace is assembled without leaking private imports or source/tests.

Tests should use temporary fixture workspaces and assert both success and fail-loudly behavior. Compiler changes require a focused regression covering the smallest syntax or graph shape that exposes the rule. Tests must not depend on a network checkout.

Bedrock tests are example-driven specifications, not coverage decoration. Test empty values, boundary values, malformed values, host-path differences, input immutability, deterministic ordering, idempotence where meaningful, and every tagged failure code. For normalization, test formatting-equivalent inputs and meaningfully distinct near-neighbors side by side.

Coverage thresholds are enforced ratchets, not aspirational targets: the current 50% branches, 79% functions, 67% lines, and 63% statements floors sit immediately below the measured baseline so regressions fail promptly. Maintain or raise them as exercised compiler surface grows. Lowering a threshold requires an explicit architectural justification.

Run `npm run fix` before committing and `npm run check` after committing so the verification applies to the exact carried tree.

## Migration Discipline

Extraction from `flight-hx` must preserve its generated Haxe byte-for-byte once that repository adopts this package. Move general analysis into the neutral packages before changing semantics. Move Haxe-specific analysis, lowering, and emission into `compiler-backend-hx`; runtime and integration support remain in `flight-hx`.

Extraction from `flight-rs` follows after the Haxe seam is proven. Move its Rust-specific lowering and emitter into `compiler-backend-rs` while keeping task runtimes, standard-library support, Cargo workspace structure, examples, and integration tests downstream. Port Rust-only task, ownership, host-capability, and conformance concepts only when their neutral meaning is separated from their Rust representation.

Generated Haxe and Rust are disposable outputs and do not belong in this repository. Shared oracle vectors may be added later only with a versioned deterministic schema, explicit provenance, and an idempotence gate.
