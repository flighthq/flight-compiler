---
package: '@flighthq/compiler-orchestration'
status: solid
score: 60
updated: 2026-08-20
ingested:
  - source
  - agents/compiler-foundations.md
---

# compiler-orchestration — Review

Deterministic pass composition: ~475 lines in one implementation source. It takes lowered modules, applies patches, drives a backend and validates the emitted set — the only place that knows the pipeline's shape.

## Verdict

**solid — 60/100.** Small, correct and doing exactly what it claims: composition order is fixed, the emitted set is validated for identity and path collisions, diagnostics abort rather than emit partially, and nothing is host-order dependent. The score reflects that a compiler driver's domain is much larger than composition — reporting, incrementality, cancellation and a request/result contract are all absent, and the report it produces today counts files rather than describing a compilation.

## What a fully expressed compiler-driver domain looks like

- **A versioned request and result contract.** A caller describes what to compile and receives a structured result — emitted files, diagnostics, patch audit, coverage, timings — with a schema that can cross a process boundary. This is the seam a downstream repository actually integrates against.
- **Deterministic composition** with a stated pass order and no host dependence. Present for the fixed pipeline; a fuller version composes each backend's _elected_ lowering passes, since whether a feature is unwrapped is a target decision rather than a global one.
- **Complete diagnostic aggregation** across every pass — inventory, lowering, patching, emission — reported together with severity, so a caller sees every problem in one run rather than the first.
- **Partial success where it is meaningful.** A large port wants "emit what compiles, report what did not" as an option, not only all-or-nothing.
- **Incrementality.** Re-compiling one changed module does not re-lower a checkout.
- **Cancellation and progress** for long runs.
- **A real report**: what was compiled, from which upstream revision, which declarations lowered or refused, which patches applied, and what the output covers — enough that a target repository can track its own readiness without a second tool.
- **Multi-backend composition.** Emitting Haxe and Rust from one lowered set in one pass, sharing the analysis cost.
- **Emitted-set validation**: duplicate identity, colliding paths under every host's rules, and the empty-output case. Largely present.

## Present capabilities

- **Fixed, stated pass order.** Validate module identity, apply patches, sort modules, emit, normalize, sort files, validate the set. Reading the function tells you the pipeline.
- **All-or-nothing on diagnostics.** `compileTypeScriptModules` collects lowering diagnostics across every source, sorts them deterministically, and throws a tagged `CompilerDiagnosticsFailure` rather than emitting a partially lowered module — the contract the architecture document states.
- **Emitted-set validation with real collision identity.** Duplicate module identity and duplicate emitted paths are tagged invariant failures, and path comparison now rejects exact, case-only and Unicode-equivalent collisions, so two files that differ only by case cannot both land on a case-insensitive host.
- **Deterministic ordering, machine-independent.** Modules and files sort through the shared `compiler-canonical-form` code-unit primitive, so a machine's locale cannot reorder output.
- **Caller input untouched.** Patching clones, and the orchestration path never mutates the modules it is handed — exercised by an immutability test.
- **Tagged failures throughout.** Diagnostics and invariants both carry codes and guards; the bare `Error`s that used to sit here are gone.
- **A versioned report discriminant.** `flight-compiler-report/1` exists as a shape.

## Gaps

- **The report is three numbers.** Backend name, emitted file count, module count. It cannot tell a caller which declarations refused, which patches applied, what upstream revision produced it, or how long anything took — so a downstream repository tracking migration readiness has to derive all of it independently. This is the single largest gap in the package.
- **`diagnostics` is always empty in the IR path.** `compileIrModules` returns `diagnostics: []` unconditionally; only the TypeScript entry point produces them, and it throws rather than returning them. A caller that wants diagnostics _and_ output cannot have both.
- **No request contract.** The entry points take a backend instance and options directly, so every caller constructs the pipeline. There is no serializable description of a compilation, which is what the roadmap's drop-in condition ultimately needs.
- **No incrementality, no caching, no cancellation, no progress.** Every compilation is whole and synchronous.
- **One backend per call.** Emitting both targets means lowering twice, so the analysis cost — by far the most expensive part — is paid per target rather than shared.
- **No partial-success mode.** All-or-nothing is right as a default and wrong as the only option for a port that is 20% covered: today a single unsupported construct in one module fails the whole run, which makes incremental migration harder than it needs to be.
- **No emitted-set shape checks.** Zero files is a legal result, which is the "gate with no evidence" shape the testing conventions warn about.
- **Patch audit passes through unexamined.** Orchestration returns the audit it is given without relating it to what was emitted, so nothing verifies that a patch that claimed to apply actually affected output.
