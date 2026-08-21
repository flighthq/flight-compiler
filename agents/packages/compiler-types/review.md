---
package: '@flighthq/compiler-types'
status: foundational
score: 72
updated: 2026-08-20
ingested:
  - source
  - agents/compiler-foundations.md
---

# compiler-types — Review

The vocabulary package: 18 contract sources and one barrel, ~1,600 lines, no implementation dependency, no runtime exports at all. Every other package's public shapes live here, and the naming contract makes that structural rather than conventional — an exported `interface` or `type` outside this package is a `packages:check` failure.

## Verdict

**foundational — 72/100.** This is the right shape for a vocabulary package and the recent splits made it navigable: the omnibus IR became declaration, type, executable, module, operator, binding and access families, each with a compile-time composition test. Closed operator vocabularies are the standout — drift between the contract and either consumer is now a type error, verified by planting drift in both directions. What keeps the score in the seventies is that a vocabulary is judged by whether it can express its domain, and several families are still coverage-driven rather than designed: the type IR has no story for conditional, mapped or template-literal types, and there is no serialization boundary at all.

## What a fully expressed compiler-vocabulary domain looks like

- **Total coverage of the source language it claims to model**, with every construct either representable or explicitly named as out of scope. A neutral IR for TypeScript that cannot express a mapped type has not decided whether mapped types are unsupported or unmodelled, and those are different claims.
- **Illegal states unrepresentable.** Cardinality, heritage, discriminant and operand constraints are carried by the types, so a malformed IR fails to compile rather than failing to emit.
- **Closed vocabularies wherever the source language has a closed set** — operators, modifiers, visibility, primitive kinds — so a consumer's handling is exhaustive by construction and drift is a compile error.
- **A versioned serialization boundary**: a documented wire format, a parser that validates untyped input into the typed model, and a schema version that changes deliberately. Without it the IR cannot cross a process, be cached, or be diffed by a tool that is not this compiler.
- **Deliberate mutability.** Every collection is readonly unless mutation is part of the contract, stated once rather than per-field.
- **Identity and provenance on every node that can be patched, diagnosed or reported**, so a diagnostic can always point at something stable.
- **Type-level tests as first-class**: assignability, inference and exhaustiveness properties asserted with `expectTypeOf` and `@ts-expect-error`, because for a type-only package the typechecker _is_ the test runner.
- **A stability policy**: which parts are frozen, which are provisional, and what a breaking change to each requires.

## Present capabilities

- **One home, structurally enforced.** No other package exports a contract; `packages:check` rejects an exported interface or type alias anywhere else, including the `type X = …; export type { X }` form.
- **Coherent family split.** Declaration, type, executable, module, operator, operator-semantic, binding, access, source-identity, diagnostic, inventory, orchestration, patch, backend, host-endpoint, static-fact, target-naming and TypeScript-interop contracts each occupy their own source with a colocated composition test. Navigation is by concept rather than by scrolling.
- **Closed operator vocabularies.** `IrAssignmentOperator`, `IrBinaryOperator` and the prefix/postfix sets are exact string unions. Both backends map them through `Record<IrOperator, …>`, so adding a member fails typecheck in `compiler-backend-hx` and `compiler-backend-rs` simultaneously, and dropping a TypeScript token mapping fails in `compiler-semantic`. Verified by planting drift in each direction.
- **Narrowed structural states.** Compound-type cardinality, class heritage, constructor shape and type-parameter families reject invalid combinations at the type level rather than in an emitter guard.
- **Identity is shared, not re-declared.** `CompilerSourceIdentity`, `CompilerModuleIdentity`, `CompilerExportIdentity` and `CompilerSourceOrigin` are one family that the IR, patches and inventory all extend, so "where did this come from" has a single answer.
- **Tagged failure contracts.** Backend emission, compiler invariants, semantic patches, inventory and target-name allocation each carry a code union and a guard, and the codes are bound to their runtime registries by `satisfies Record<Code, …>` so an added code fails to compile until the guard learns it.
- **Schema discriminants where interchange already exists** — `flight-compiler-report/1`, `flight-compiler-inventory/1`, `flight-compiler-patch-audit/2`.
- **Readonly by default.** Public collections are `readonly`, and the immutability that follows is exercised by the consumers' caller-input tests.

## Gaps

- **The type IR is coverage-driven, not complete.** It models what the current lowerer meets: primitives, arrays, tuples, unions, intersections, objects, functions, `keyof`, indexed access, `typeof`. TypeScript's type system also has conditional types, mapped types, template-literal types, `infer`, variadic tuples, recursive aliases and declaration merging. None are representable and none are declared out of scope, so the contract cannot currently say whether `Partial<T>` is unsupported or merely unmet — which is exactly the ambiguity the foundations audit warns about.
- **No serialization or parser boundary.** There is no wire format, no `parseIrModule`, no schema version on the IR itself. That is a deliberate deferral — freezing a provisional model would be worse — but it means the IR cannot be cached, shipped between processes, or diffed by any tool that is not this compiler, and the oracle-vector plan in the roadmap depends on it existing eventually.
- **Composition tests prove representative shapes, not exhaustive families.** Each contract has a test, but a discriminated union with fourteen members is typically exercised by two or three. An exhaustiveness helper — a `satisfies Record<IrStatement['kind'], unknown>` fixture per family — would turn "we modelled a new statement kind" into a compile error in the test rather than a silent omission.
- **No stability policy.** Everything is implicitly provisional because the package is pre-release, but a vocabulary package is the one place where "which names are we prepared to defend" should be written down. The foundations audit says do not declare the IR stable; the contract does not say which parts are closest.
- **Mutability is consistent but unstated.** Readonly is applied well; the _rule_ for when a collection is mutable by contract is not recorded here, so the next contributor infers it from neighbours.
- **Host-endpoint and static-fact contracts are new and thinly exercised.** They arrived with the inventory and semantic-fact work and have the least composition coverage of the families; worth a second pass once their consumers settle.
