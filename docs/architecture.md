# Architecture

## Ownership boundary

`@flighthq/tool-compiler` owns everything from a Flight TypeScript checkout through deterministic target source files and compiler reports:

```text
checkout -> inventory/symbol graph -> semantic lowering -> neutral IR -> patches -> backend lowering/emission
```

This includes concrete Haxe and Rust compiler backends. A backend may define target-only compiler models and transformations, but they sit after the neutral IR boundary.

`flight-hx` and `flight-rs` own the target ecosystems around those files: compiler installation, Haxelib/Cargo layout, maintained runtime and standard-library implementations, host adapters, examples, oracle bridges, integration tests, packaging, and release workflows.

## Stable identities

The compiler uses four independent identities:

- Package: exact npm package name.
- Module: package plus source path relative to the upstream checkout.
- Declaration: package, source path, and exported declaration name.
- Revision: upstream Git commit plus normalized declaration fingerprint.

Machine-specific absolute paths never enter models or reports. A semantic patch includes the declaration identity and expected fingerprint; an upstream edit therefore makes the patch stale instead of silently applying it to changed code.

## Pipeline

Inventory resolves every manifest export lane, re-export chain, runtime binding, and SDK exposure before emission. Export-star graphs propagate declaration candidates to a fixed point, so cyclic barrels are lane-order independent and ambiguous names are reported rather than selected by traversal order. Cross-package edges resolve only through declared package export lanes.

Semantic lowering reports `accountedDeclarations` as the number of top-level declaration syntax nodes inspected (with each variable declarator counted separately) and `accountedExports` as the number of standalone export statements plus default-export modifiers inspected. Re-export and export-assignment syntax is retained in `IrModule.exports`; a backend must lower those records or reject the module. Structured diagnostics cover unsupported syntax, and compiler orchestration refuses to emit a partially lowered module.

Neutral patches run before backend emission. Backend-scoped patches use the same identity and audit machinery but apply only to the named backend. Emitted file paths are validated as relative, traversal-free paths, normalized to forward slashes, sorted, and checked for duplicates.

## Extraction order

Haxe is first because `flight-hx` has the broader semantic analyzer and an upstream Vitest oracle. Its existing generated output is the byte-stability check for moving rules here. Rust follows over the same inventory, neutral IR, patch system, and orchestration; Rust ownership and task lowering remain backend stages.

The initial compiler slice intentionally fails on constructs whose existing target repositories still lower with target-fused logic. Each migration adds a neutral regression or a backend regression before moving the corresponding rule. Unsupported syntax is never emitted approximately or omitted from accounting.

`npm run check` executes the coverage run and enforces the repository's current measured coverage floor. Raising those thresholds accompanies future compiler surface growth; they are a regression gate, not an aspirational configuration outside CI.
