# Flight Compiler

`@flighthq/tool-compiler` is the shared TypeScript compiler for mechanical ports of the [Flight SDK](https://github.com/flighthq/flight).

The package owns the complete source-compilation path:

- Flight workspace, package, export-lane, and symbol analysis
- normalized declaration fingerprints and source provenance
- a target-neutral intermediate representation
- deterministic, identity-based semantic patches and patch audits
- coverage and API inventory models
- compiler orchestration and target-backend infrastructure
- concrete Haxe and Rust lowering and source emission

[flight-hx](https://github.com/flighthq/flight-hx) is the first integration target; [flight-rs](https://github.com/flighthq/flight-rs) is the second. Those repositories retain their target ecosystem: runtime and standard-library support, project layout, examples, and integration tests. Compiler-owned target rules and emitters live here so both ports use one versioned toolchain.

Development follows Flight's package-per-domain architecture. Nine private `@flighthq/compiler-*` workspaces isolate contracts, analysis, provenance, patches, emission, target backends, and orchestration; the repository publishes them as one self-contained `@flighthq/tool-compiler` artifact. Workspace source trees are flat, contracts are centralized in `compiler-types`, and implementations use functions and plain data instead of classes.

## Install

```sh
npm install @flighthq/tool-compiler
```

The package is not published yet. During extraction, target repositories can install a packed local build.

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
