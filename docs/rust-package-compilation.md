# Rust package compilation and module initialization

This document is the durable contract for the Rust backend's package-compilation and module-initialization fold. It describes the plan chain, the exact execution order, the lifecycle guarantees, the runtime ABI, and what this repository does and does not own. It describes the current implementation, not a proposed future phase.

## Plan chain

One compilation produces a chain of exact, versioned plans. Each step consumes the previous one and adds target evidence; no later step re-derives an earlier decision.

1. **Neutral module evaluation** (`flight-compiler-module-evaluation/1`, `compiler-module`). The authoritative evaluation projection: entries, dependency edges (runtime or type-only), strongly connected groups, ordered declaration steps, live bindings, and the source-language semantics (depth-first request order, dependency-first evaluation, read-only live import aliases, TDZ throwing, top-level `await` refused).
2. **Rust representation plan** (`flight-rust-module-evaluation-representation-plan/1`, `compiler-backend-rs`). Maps every neutral module to its Cargo crate and module locator, decides how each binding is stored (function item, primitive constant, private scalar state, reference carrier, or unrepresented), records per-module lifecycle intents, and refuses a compilation whose output closure is incomplete. It describes representation only; it allocates no call order.
3. **Execution plan** (`flight-rust-module-evaluation-execution-plan/1`, `compiler-backend-rs`). Binds the representation to the host-callable lifecycle ABI: one crate-owned public doc-hidden hook per neutral group per phase, the ordered instantiate phase followed by the ordered evaluate phase, the entry list, the typed error contract, and the fixed semantics. This plan is the single authority for group ownership and call order.
4. **Emission plan** (`flight-rust-module-evaluation-emission-plan/1`, `compiler-backend-rs`). Renders the per-module `pub(crate)` lifecycle hooks and the group hooks as Rust fragments addressed by crate and module path. It chooses no source tree and never reorders the execution plan.
5. **Finalization** (`rustSourceTreeFinalization`, `compiler-backend-rs`). Injects each fragment into its canonical crate-root file, refuses duplicate or mismatched targets, and returns the finalized execution plan in `targetInitialization`. Orchestration passes that plan into the public-binding request; `report.publicBindings.initialization` carries it to consumers.

## Exact order: two passes, no coarse initializer

The execution plan lists every instantiate invocation before every evaluate invocation. Each neutral group receives exactly one generated hook per phase:

```rust
#[doc(hidden)]
pub fn __flight_instantiate_group_<n>() -> std::result::Result<(), flight_runtime::FlightModuleEvaluationError>
#[doc(hidden)]
pub fn __flight_evaluate_group_<n>() -> std::result::Result<(), flight_runtime::FlightModuleEvaluationError>
```

A group hook calls each of its modules' `pub(crate)` phase hooks in the neutral group's own order with `?`, then returns `Ok(())`. There is no per-crate eager initializer: a crate root owns its group hooks and nothing drives them by itself. The downstream embedding owns one global serialized bootstrap that invokes every planned instantiate hook in plan order and only then every evaluate hook in plan order. The compiler never invents a second schedule.

## Per-module lifecycle and failures

Every module in an evaluation group carries a private `Mutex<__FlightModuleEvaluationState>` with six states: `Uninstantiated`, `Instantiating`, `Instantiated`, `Evaluating`, `Evaluated`, `Errored(error)`. The lock is released before any nested module call so generated hooks cannot deadlock on each other, and a poisoned lock is recovered rather than propagated.

A phase hook:

- returns `Ok(())` when its state is already cached for that phase (`Instantiated`/`Evaluated` for instantiate, `Evaluated` for evaluate);
- returns `runtime::module_evaluation_reentrancy_error()` when the module is in a transitional state, rejecting re-entrant bootstrap work instead of blocking or recursing;
- returns a clone of the stored sticky error when the state is `Errored(error)`, so the first failure is cached and no retry or second error can replace it;
- otherwise transitions to `Instantiating`/`Evaluating`, releases the lock, performs the phase work, and records `Instantiated`/`Evaluated` or `Errored(error.clone())` with the same result it returns.

The runtime value `flight_runtime::module_evaluation_reentrancy_error()` is part of ABI v4; the compiler only names it.

## Current eligibility: erased steps only

The executable slice admits neutral steps the representation plan can erase: function items, primitive constants, and private scalar state, plus the lifecycle driver step that only advances the module state. The generated phase hooks currently contain no top-level side effects, assignment lowering, TDZ carrier, or abrupt-completion lowering; a step that needs any of those refuses in the representation plan and makes the whole initialization projection ineligible. This is deliberate: an all-or-nothing schedule is safer than hooks that silently skip a step.

## Runtime ABI v4

`flight-rust-runtime-abi/4` (requirements schema `flight-rust-runtime-requirements/2`) adds the nested `flight-rust-runtime-module-evaluation-requirements/1` block. It requires a runtime-owned `FlightModuleEvaluationError` implementing `Clone + Send + Sync + 'static`, and the operation `module_evaluation_reentrancy_error` returning that error. The runtime crate spelling defaults to `flight_runtime` and follows the backend's `runtimeCrate` option; the public-binding planner rejects a plan whose error crate disagrees.

`flight-rs` owns the real runtime implementation, the error type and reentrancy operation, Cargo workspace/crate layout, and the one global serialized bootstrap. This repository contains no `flight-rs` checkout and generates no bootstrap, Cargo manifest, or facade gate. The only `FlightModuleEvaluationError` here is a test double in `golden/support/rust/flight_runtime.rs`, documented as downstream-owned, that lets emitted fragments compile in compiler tests.

## Public binding v3 and access

`flight-rust-public-binding-plan/3` keeps every v2 field and adds:

- `initialization`: when available, it carries the finalized execution plan verbatim with `required: 'before-value-access'`; when refused, it carries `rust-public-binding-initialization-refused` and the exact representation refusals. There is no partial initializer.
- per-binding `access`: `immediate` for type-space names, `after-bootstrap` for value and module carriers when initialization is available, and `refused` for value/module carriers when it is not. A binding the v2 plan already refused stays refused regardless of space.

Type names remain usable when target initialization is refused; value and module names must not be advertised as safely accessible without a complete available initializer. `flight-rust-public-binding-plan/2` remains understood for older profiles.

## Strict, best-effort, and the handoff

Initialization is all-or-nothing. Any target refusal, refusal placeholder, omitted module, cross-crate cycle, or unrepresented step makes the representation projection incomplete; the execution plan is then refused, the emission plan produces no fragments, and the public-binding plan reports refused initialization. A placeholder never composes into callable lifecycle hooks. Strict runs report the refusals and exit non-zero; finalization planning failures throw before files are written. Best-effort runs still return files and type bindings, with explicit initialization and value-access refusals.

`report.initialization` remains the neutral `flight-compiler-module-evaluation/1` plan. The target schedule lives only in `report.publicBindings.initialization`. The programmatic `CompilerPackageCompilationResult.report` is the canonical downstream handoff; the CLI forwards `publicBindings` in its result but does not yet persist a generation manifest.

A higher-level initialized-SDK facade projection and any automatic value-access gate belong to the downstream integration and are not implemented here.
