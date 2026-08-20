# Compiler Migration Roadmap

## Outcome

This repository will publish `@flighthq/tool-compiler`, the one versioned TypeScript compiler used by `flight-hx` and `flight-rs` for Flight source generation. The compiler owns inventory and symbol analysis, provenance and fingerprints, semantic analysis, a target-neutral IR, patch identity, orchestration, backend infrastructure, and concrete Haxe and Rust lowering and source emission.

The downstream repositories continue to own their target ecosystems: maintained runtimes and standard-library implementations, Haxelib or Cargo project structure, examples, compiler integration tests, packaging, releases, and host or oracle wiring. Generated target source is disposable output and does not live here.

## Current position

The repository foundation is established: functional package boundaries, centralized contracts, initial inventory and provenance, a neutral IR with deterministic value- and type-space binding identity, deterministic patching and orchestration, and skeletal Haxe and Rust backends all exist. The build produces one self-contained public artifact from nine private `@flighthq/compiler-*` packages, and the health gates cover formatting, linting, strict type checking, matching source/test concepts and exported-function suites, isolated tests, aggregate coverage, package boundaries, clean builds, and tarball contents.

It is not yet a drop-in replacement for either downstream generator. The existing target repositories still contain most of the production semantic lowering, host analysis, reporting, and source-emission behavior. The estimates below are planning estimates as of 2026-08-18, not release claims:

| Area | Estimated readiness | Principal remaining work |
| --- | --: | --- |
| Repository and package architecture | 85–90% | Publication lifecycle, consumer smoke test, and release gates |
| Inventory and provenance | 55–60% | Full downstream export, host-endpoint, static-fact, and exclusion behavior |
| Neutral IR and semantic lowering | 20–25% | The majority of production TypeScript semantics and diagnostics |
| Haxe generator parity | 10–15% | Target lowering, naming, reports, patches, and byte-stable emission |
| Rust generator parity | 5–10% | Target lowering, ownership, tasks, rejections, host concerns, and emission |
| Downstream drop-in integration | 0% | No downstream repository installs this package in place of its generator yet |

Overall drop-in readiness is approximately 15%. The architecture is much closer to complete than the compiler behavior; those are intentionally reported separately.

The present neutral lowerer and target backends cover a useful first slice, but still fail loudly on major areas such as tasks and async behavior, optional access, destructuring, structural types, target host mappings, mutable module state, rejection lowering, many operators and facades, and Rust ownership decisions. Failing loudly is the correct interim behavior; unsupported declarations must never be silently approximated or omitted.

## Definition of drop-in

A target is ready to switch only when all of these conditions hold:

1. The old and new compilers run against the same pinned Flight revision and the same downstream configuration.
2. Generated target source, file paths, inventories, patch audits, and compiler-owned reports match byte-for-byte, except for deliberately reviewed and versioned corrections.
3. Every migrated compiler-owned downstream test has an equivalent test here, while runtime and ecosystem integration tests continue to pass downstream.
4. The packed public artifact installs into a clean consumer without access to this monorepo or its private workspaces.
5. The downstream compiler command uses `@flighthq/tool-compiler`; the superseded generator implementation and duplicate compiler tests are then removed downstream.
6. Re-running generation is deterministic and leaves the downstream working tree clean.

Haxe reaching this bar does not imply Rust parity. Each backend crosses its own compatibility and downstream-adoption gate.

## What tests move here

Move tests whose subject is compiler behavior:

- package, export-lane, symbol, runtime-value, and source-provenance analysis;
- TypeScript-to-neutral lowering and structured unsupported-syntax diagnostics;
- patch matching, stale fingerprints, ambiguity, audits, and determinism;
- target naming, target semantic lowering, emitted source, file layout, and compiler reports;
- generator fixtures and golden outputs that can run without a target runtime;
- old-versus-new parity vectors pinned to explicit upstream and downstream revisions.

Keep tests downstream when their subject is the target ecosystem:

- Haxe runtime and standard-library behavior, Haxelib layout, host integration, examples, and end-to-end projects;
- Rust runtime and standard-library behavior, Cargo layout, ownership exercised by the runtime, WASM or native-host integration, examples, and conformance execution;
- installation and release behavior belonging specifically to `flight-hx` or `flight-rs`.

Do not copy every downstream test preemptively. Move a compiler-owned test with the production behavior it protects, preserve its fixture provenance, and keep a downstream integration seam until adoption is complete. The earlier inventory found 12 generator-focused Haxe test files; they are candidates for migration, not a claim that all Haxe tests belong here.

## Phases

### 0. Repository foundation

Status: structure complete; bedrock contract hardening in progress.

- Maintain the private `compiler-*` domain packages and the public `tool-compiler` workspace.
- Keep all contracts in `compiler-types`, source trees flat, implementation class-free, and dependency edges acyclic.
- Outside the type-only `compiler-types` workspace, require every non-barrel package source to have its matching colocated test and every exported function to have an exact named suite; treat this as a structural floor rather than a coverage claim.
- Preserve deterministic build, package, coverage, and boundary gates as the implementation grows.
- Complete the maturity work in [Compiler foundations](compiler-foundations.md) from contracts through provenance, patches, and emission before expanding the higher compiler layers.

Exit criterion: `npm run check` proves a clean, self-contained public artifact; every workspace is independently testable; and the bedrock audit has no unresolved identity, determinism, failure-contract, or portability decision required by the next layer.

### 1. Freeze the compatibility contract

Status: follows foundation hardening.

- Pin representative Flight, `flight-hx`, and later `flight-rs` revisions.
- Add a parity harness that invokes both the existing downstream generator and the new compiler with identical inputs.
- Compare generated file paths and bytes plus inventory, exclusions, patch audits, and reports.
- Record the public programmatic API and command contract that downstream repositories will call.
- Classify mismatches by compiler domain so each subsequent slice has a measurable exit condition.

Exit criterion: one command produces a stable, actionable Haxe parity report without changing either checkout.

### 2. Complete shared inventory and provenance

Status: partial; neutral static-fact and checker-resolved host-endpoint primitives exist, but downstream corpus parity does not.

- Port export-lane, re-export, runtime binding, typed-structure, static-fact, host-surface, and exclusion analysis that is target-neutral.
- Preserve exact package, module, declaration, and revision identities.
- Move matching compiler-owned fixtures and failure tests with each capability.
- Reject target-specific facts from neutral contracts unless their target-independent meaning is explicit.
- Keep host receiver matching as an injected checker capability and host runtime implementation or conformance coverage in the target repositories.

Exit criterion: Haxe inventory and compiler-input reports match for the pinned corpus before target emission begins.

### 3. Expand semantic lowering and the neutral IR

Status: initial slice only.

- Port TypeScript constructs vertically: contract in `compiler-types`, neutral lowering, diagnostics, tests, then both backend responses.
- Prioritize constructs that unlock the most Haxe files: optional access, destructuring, structural values, callbacks, module state, operator/facade mappings, and async/task meaning.
- Keep target ownership and syntax out of the neutral model.
- Require every public declaration to lower, patch, or return a structured diagnostic.

Exit criterion: the pinned Haxe corpus lowers completely with no unexplained skipped declaration.

### 4. Reach Haxe backend parity

Status: skeletal backend.

- Port Haxe-specific naming, host mapping, semantic lowering, file layout, source emission, patches, exclusions, and reports in vertical slices.
- Move the corresponding generator unit and golden tests here with each slice.
- Preserve generated Haxe byte-for-byte unless a separately reviewed compiler correction intentionally changes the golden output.
- Add write and check modes around the same deterministic compilation result; keep filesystem capabilities explicit.

Exit criterion: old-versus-new Haxe parity is clean across the maintained corpus and repeated generation is idempotent.

### 5. Adopt in `flight-hx`

Status: not started.

- Install a packed `@flighthq/tool-compiler` artifact in a clean `flight-hx` checkout.
- Replace the old generator entry point without changing runtime or project ownership.
- Run downstream unit, integration, example, and packaging gates.
- Remove superseded compiler implementation and duplicate generator-only tests after the switch passes.

Exit criterion: `flight-hx` uses the package as its only source generator and its full lifecycle is green.

### 6. Reach Rust parity and adopt in `flight-rs`

Status: initial slice only; begins after the Haxe seam is proven.

- Reuse the established inventory, provenance, neutral lowering, patching, orchestration, parity harness, and public API.
- Port Rust naming and emission plus ownership, tasks, rejection behavior, host capability, conformance, native-host, and WASM compiler concerns at the correct neutral or backend boundary.
- Keep runtime implementation, Cargo structure, examples, and execution integration downstream.
- Require generated-source parity and successful downstream Cargo compilation and tests before removal of the old generator.

Exit criterion: `flight-rs` uses the package as its only source generator and its full lifecycle is green.

### 7. Publication and lifecycle maturity

Status: partial.

- Snapshot or otherwise enforce the public API contract.
- Pack and install the actual tarball into a clean external consumer smoke fixture.
- Add version, changelog, release, provenance, and publish-dry-run policy before the first release.
- Add an all-gates runner that reports every independent failure instead of stopping at the first one.
- Add scoped package check and fix commands, commit-message and staged-file hooks, and a pre-push fast gate where they improve local feedback.
- Document supported Node versions, artifact layout, licensing, release recovery, and the downstream version-compatibility policy.

Flight's product-specific browser, rendering, evidence, asset, capture, and capability checks do not belong here unless this compiler later acquires the corresponding responsibility.

Exit criterion: a tagged release can be built, inspected, installed, verified, and reproduced through documented commands.

## Recommended next work

Work from the dependency floor toward parity:

1. Review the identity and failure vocabulary in `compiler-types`, without declaring the complete neutral IR stable or serializable.
2. Finish and freeze the narrow `compiler-provenance`, `compiler-patch`, and `compiler-emission` primitives against the maturity rubric in [Compiler foundations](compiler-foundations.md).
3. Audit `compiler-inventory` as the first composition above bedrock, adding direct tests for package discovery, export lanes, runtime bindings, host facts, exclusions, and deterministic reports.
4. Review neutral declarations and types before expanding expression and statement lowering.
5. Define the public compile request/result only after the core vocabulary it exposes is worth preserving.
6. Build the pinned Haxe parity harness when it can measure a stable compiler seam, then use mismatches to drive vertical capability slices.
7. Defer the Rust production migration until the public seam and parity workflow have survived Haxe adoption.

This order optimizes for trustworthy primitives rather than the earliest downstream switch. Parity remains the proof that the composition is correct, but downstream implementation details do not get to define weak primitives by accident.
