# Flight Compiler

`@flighthq/tool-compiler` is being built as the shared TypeScript compiler for mechanical ports of the [Flight SDK](https://github.com/flighthq/flight).

The package's intended ownership is the complete source-compilation path:

- Flight workspace, package, export-lane, and symbol analysis
- normalized declaration fingerprints and source provenance
- a target-neutral intermediate representation
- deterministic, identity-based semantic patches and patch audits
- coverage and API inventory models
- compiler orchestration and target-backend infrastructure
- concrete Haxe and Rust lowering and source emission

[flight-hx](https://github.com/flighthq/flight-hx) is the first integration target; [flight-rs](https://github.com/flighthq/flight-rs) is the second. Those repositories retain their target ecosystem: runtime and standard-library support, project layout, examples, and integration tests. Compiler-owned target rules and emitters live here so both ports use one versioned toolchain.

Development follows Flight's package-per-domain architecture. Fifteen private `@flighthq/compiler-*` workspaces isolate contracts, analysis, provenance, patches, structural semantics, emission, target backends, and orchestration; the public `packages/tool-compiler` workspace assembles them into one self-contained artifact. The repository root is a private development workspace. Source trees are flat, contracts are centralized in `compiler-types`, and implementations use functions and plain data instead of classes.

The architecture and health foundation are in place, but the current compiler is not yet a drop-in replacement for the generators in `flight-hx` or `flight-rs`. Work proceeds from the dependency floor described in [Compiler foundations](agents/compiler-foundations.md); the [compiler migration roadmap](agents/compiler-migration-roadmap.md) tracks the later parity and extraction sequence.

## Install

```sh
npm install @flighthq/tool-compiler
```

The package is not published yet. During extraction, target repositories can install a packed local build after each target reaches its parity gate.

## Usage

```ts
import { analyzeFlightWorkspace } from '@flighthq/tool-compiler';

const inventory = analyzeFlightWorkspace({
  upstreamDirectory: '/path/to/flight',
});
```

The upstream directory must be an initialized Flight Git checkout. Analysis is read-only and deterministic for a fixed checkout and compiler version.

## Development

```sh
npm install
npm run fix
npm run check
```

`npm run check` validates every workspace manifest and dependency boundary, formats, lints, type-checks each package, runs both isolated and coverage test lanes, builds the assembled artifact, and inspects the package tarball. See [AGENTS.md](AGENTS.md) for architecture and contribution rules.

## License

[MIT](LICENSE.md)
