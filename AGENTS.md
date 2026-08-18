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
       -> Haxe ownership lowering + emitter + runtime
       -> Rust ownership lowering + emitter + runtime
```

Core owns TypeScript program construction, package and export-lane resolution, symbol identity, runtime/type-only classification, normalized fingerprints, source provenance, neutral IR, semantic patch identity, and shared report schemas.

This package also owns compiler orchestration, the backend contract, target-specific semantic and ownership lowering, language naming, emitted file layout, and concrete Haxe and Rust source emitters. Target-specific data belongs under its backend model and must not leak into the neutral IR.

Target repositories own ecosystem concerns: maintained runtime support, target standard-library implementations, package or crate/project structure, examples, integration tests, compiler installation, and host/oracle wiring. Compiler output may refer to an explicit runtime contract, but runtime implementation source stays downstream.

Haxe is the first integration target and defines the initial compatibility bar. Rust follows against the same neutral model and orchestration path. New core abstractions must still be genuinely target-neutral; “both current targets happen to need it” is evidence, not proof.

## Source Layout

- `src/analyze/`: read-only TypeScript and Flight workspace analysis.
- `src/backend/`: backend contracts and shared source-emission infrastructure.
- `src/backends/haxe/`: Haxe-specific lowering, naming, and source emission.
- `src/backends/rust/`: Rust-specific lowering, naming, and source emission.
- `src/compiler/`: deterministic orchestration from analyzed workspace to emitted files and reports.
- `src/model/`: stable target-neutral data contracts.
- `src/patch/`: fingerprinted semantic patch application and audits.
- `src/index.ts`: cultivated public package surface.
- `tests/`: focused compiler fixtures and public-contract tests.
- `docs/`: durable architecture and migration decisions.

Keep imports side-effect-free. Importing the package must not read a checkout, start work, mutate registries, or write reports. Filesystem work begins only when a caller invokes an explicit function.

## Modeling Rules

- Parse TypeScript with the TypeScript compiler API. Never infer syntax or exports with regular expressions.
- Resolve complete package export lanes and re-export chains before a target chooses what to emit.
- Preserve Flight’s free-function identities, `create<Type>` allocation boundary, explicit `out` parameters, aliasing semantics, and sentinel behavior in the neutral model.
- Every public export is lowered, patched, or represented by a structured diagnostic. Never silently drop a declaration.
- Every declaration and patch retains stable upstream identity: package name, source path, export name, and normalized SHA-256 fingerprint.
- Deterministic outputs contain no timestamps, machine-specific absolute paths, or filesystem iteration order.
- Expected environmental absence returns a structured result where the API defines one. Invalid compiler configuration, unresolved public exports, ambiguous patches, and stale fingerprints fail loudly.
- Prefer small free functions and plain data. Classes are appropriate only when an actual stateful compiler session needs encapsulation.
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
- `npm run test:coverage`: run unit coverage.
- `npm run typecheck`: strict no-emit TypeScript check.
- `npm run build`: emit ESM JavaScript, declarations, maps, and declaration maps to `dist/`.
- `npm run pack:check`: inspect the publishable tarball without writing one.

Tests should use temporary fixture workspaces and assert both success and fail-loudly behavior. Compiler changes require a focused regression covering the smallest syntax or graph shape that exposes the rule. Tests must not depend on a network checkout.

Run `npm run fix` before committing and `npm run check` after committing so the verification applies to the exact carried tree.

## Migration Discipline

Extraction from `flight-hx` must preserve its generated Haxe byte-for-byte once that repository adopts this package. Move general analysis into the neutral core before changing semantics. Move Haxe-specific analysis, lowering, and emission into `src/backends/haxe/`; runtime and integration support remain in `flight-hx`.

Extraction from `flight-rs` follows after the Haxe seam is proven. Move its Rust-specific lowering and emitter here while keeping task runtimes, standard-library support, Cargo workspace structure, examples, and integration tests downstream. Port Rust-only task, ownership, host-capability, and conformance concepts only when their neutral meaning is separated from their Rust representation.

Generated Haxe and Rust are disposable outputs and do not belong in this repository. Shared oracle vectors may be added later only with a versioned deterministic schema, explicit provenance, and an idempotence gate.
