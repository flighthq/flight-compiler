# Flight Compiler Codebase Map

This repository publishes `@flighthq/tool-compiler`, the shared TypeScript compiler used to generate non-TypeScript Flight targets. Read this file in full at the start of each session. The upstream Flight SDK is the API and behavioral source of truth; this package describes it but never edits it.

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
- `src/index.ts`: the cultivated public `@flighthq/tool-compiler` facade.
- `scripts/`: repository health, isolated testing, typecheck, clean, and package-artifact gates.
- `docs/`: durable architecture and migration decisions.

Every workspace keeps a flat `src/` and colocates its unit tests. Cross-package imports go through the dependency package's `src/index.js`. Internal packages are private development boundaries; the root build assembles them into the single public package and must not leave private package specifiers in JavaScript or declarations.

A flat source tree is not a one-file rule. Split a large concern into focused sibling files within the same `src/` before creating another workspace. Add a workspace only for a distinct domain contract, dependency boundary, or lifecycle that benefits from independent health and unit-test gates.

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

## TypeScript Style

- Use strict TypeScript, exact optional properties, and checked indexed access.
- Use `Readonly<T>` and readonly collections where mutation is not part of the contract.
- Put type-only imports on their own `import type` line.
- Keep exported functions alphabetized within a file unless pipeline order is clearer.
- Add comments only for durable invariants, ownership, identity, determinism, or compiler behavior that names cannot express.
- Do not add transient `TODO`, `FIXME`, or work-history comments to source.
- Keep commits to one Conventional Commit subject with no body or trailers.

## Commands

Use npm, not pnpm or Yarn. Node.js 22 or newer is required.

- `npm run fix`: apply Oxlint fixes and Oxfmt formatting after edits.
- `npm run check`: complete deterministic gate; run before handoff.
- `npm run test`: run Vitest once.
- `npm run test:packages`: run every private package in isolation, then the public facade.
- `npm run test:coverage`: run all unit tests together with aggregate instrumentation. The complete gate intentionally runs tests once in isolation and again for coverage because these lanes prove different properties.
- `npm run typecheck`: run the root and every workspace's strict no-emit check, collecting failures.
- `npm run packages:check`: enforce manifests, flat source trees, dependency declarations and acyclicity, centralized contracts, class-free implementation, tests, and public-facade completeness.
- `npm run build`: clean stale output and assemble ESM JavaScript, declarations, maps, and declaration maps in `dist/`.
- `npm run pack:check`: build fresh, inspect the publishable tarball, and prove every private workspace is assembled without leaking private imports or source/tests.

Tests should use temporary fixture workspaces and assert both success and fail-loudly behavior. Compiler changes require a focused regression covering the smallest syntax or graph shape that exposes the rule. Tests must not depend on a network checkout.

Coverage thresholds are enforced ratchets, not aspirational targets: the initial 45% branches, 77% functions, 65% lines, and 61% statements floors sit below the measured scaffold baseline so regressions fail immediately. Maintain or raise them as exercised compiler surface grows. Lowering a threshold requires an explicit architectural justification.

Run `npm run fix` before committing and `npm run check` after committing so the verification applies to the exact carried tree.

## Migration Discipline

Extraction from `flight-hx` must preserve its generated Haxe byte-for-byte once that repository adopts this package. Move general analysis into the neutral packages before changing semantics. Move Haxe-specific analysis, lowering, and emission into `compiler-backend-hx`; runtime and integration support remain in `flight-hx`.

Extraction from `flight-rs` follows after the Haxe seam is proven. Move its Rust-specific lowering and emitter into `compiler-backend-rs` while keeping task runtimes, standard-library support, Cargo workspace structure, examples, and integration tests downstream. Port Rust-only task, ownership, host-capability, and conformance concepts only when their neutral meaning is separated from their Rust representation.

Generated Haxe and Rust are disposable outputs and do not belong in this repository. Shared oracle vectors may be added later only with a versioned deterministic schema, explicit provenance, and an idempotence gate.
