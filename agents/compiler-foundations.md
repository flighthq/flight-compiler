# Compiler Foundations

## Purpose

This document defines the dependency floor of `@flighthq/tool-compiler` and the standard for calling a foundational package mature. It deliberately works from primitives toward integrations. Downstream parity remains necessary, but it is not allowed to freeze weak vocabulary or accidental behavior into the compiler core.

## Dependency floor

```text
compiler-types        compiler-provenance

compiler-types
  <- compiler-patch
  <- compiler-emission

compiler-types + compiler-provenance
  <- compiler-inventory
  <- compiler-semantic

compiler-types + compiler-emission
  <- compiler-backend-hx
  <- compiler-backend-rs

types + semantic + patch + emission
  <- compiler-orchestration
  <- tool-compiler
```

The first four packages are the bedrock review set:

1. `compiler-types` is the vocabulary, not an implementation utility package.
2. `compiler-provenance` answers whether two source identities are the same.
3. `compiler-patch` applies explicit, fingerprint-bound changes and records what happened.
4. `compiler-emission` defines portable output and inspectable backend/invariant failures.

Inventory and semantic lowering are fundamental compiler capabilities, but they are not dependency-floor primitives. They consume source identity and the shared vocabulary, and should be reviewed only after those inputs are trustworthy.

## Maturity standard

A bedrock package is mature only when all of the following are true:

- Its responsibility can be stated in one sentence without joining unrelated concerns with “and.”
- Its public vocabulary is canonical, globally understandable, and expected to survive both Haxe and Rust integrations.
- Its dependency list contains only lower primitives that are logically necessary.
- Importing it is side-effect-free; I/O and mutation begin only through explicit calls.
- Results are deterministic across process runs, filesystem order, line endings, and supported host platforms.
- Normalization preserves semantic distinctions while erasing only declared irrelevant distinctions.
- Caller-owned input remains unchanged unless mutation is explicitly named in the contract.
- Expected absence has an explicit result; misuse and invalid compiler state fail loudly through a stable tagged contract.
- Tests cover positive behavior, equivalence, counterexamples, empty and boundary values, malformed input, deterministic order, immutability, and every failure code.
- The package remains small enough to understand in isolation. A large switch or option family is evidence that a missing primitive may still be hidden inside it.

Coverage percentage alone does not establish maturity. A one-line primitive can have complete coverage and a weak contract; a type-only contract can have no runtime statements and still require extensive compile-time design scrutiny.

The repository also enforces a structural floor for runtime packages: each non-barrel source has an exactly named colocated test, and each exported function has an exact `describe('<function>')` suite. That makes missing runtime subjects visible. `compiler-types` is exempt because typecheck, useful assignability tests, and contract review—not empty runtime suites—are its appropriate evidence. Assertions inside required runtime suites must still satisfy the maturity standard above.

## Audit

### `compiler-types`

Status: foundational. Source identity, declaration/type IR, expression operator families, and value/type binding identity have been reviewed; the complete IR is not mature.

Strengths:

- It is the single home for exported compiler contracts.
- It has no implementation-package dependency.
- Contracts are plain data, discriminated unions, and function records rather than classes.
- Inventory, IR, patches, backends, and reports have explicit schema discriminants where serialized interchange already exists.
- Representative compile-time composition tests exist for useful contract relationships without imposing one runtime test per type-only source.
- Source, module, export, and source-origin identities share one readonly vocabulary rather than repeating structural fields.
- Diagnostics reuse the same globally identified, one-based source-location contract and expose a closed stable code.
- Emitted files expose portable normalized path identity separately from their normalized contents.
- Public compiler results and nested collections are readonly; implementations build mutable local state and return immutable contracts.
- Declaration, executable, module, and type IR contracts live in focused flat sources rather than one omnibus contract.
- Function types cannot carry executable default expressions, while executable parameters retain defaults where they are meaningful.
- Parameter and tuple-element cardinality excludes contradictory optional-rest states, and union/intersection contracts require at least two constituents.
- Class constructors distinguish absence from an explicit empty constructor; class and interface heritage accepts named type references rather than arbitrary types.
- Previously anonymous constructor, enum-member, function-type-parameter, tuple-element, visibility, type-alias, and type-reference contracts have stable domain names for focused testing and reuse.
- Assignment, binary, prefix-unary, and postfix-unary operators have closed target-neutral vocabularies in a focused flat contract; postfix position cannot carry a prefix-only operator.
- TypeScript token normalization and both target emission decisions are exhaustive over those vocabularies, so a TypeScript upgrade or IR addition fails typecheck until every producer and backend chooses emit or refuse.
- A cross-target golden fixture pins supported compound assignment, strict equality normalization, logical composition, and unary emission; focused backend tests pin unsupported assignment, binary, keyword-unary, and postfix decisions.
- Runtime declarations, imports, parameters, locals, loop variables, catch variables, and named function expressions introduce a shared source-backed binding identity; identifier expressions distinguish resolved bindings, ambient names, and `this` without encoding target names.
- Binding IDs are deterministic from package, portable source path, and declaration offset. The lowering pass delegates lexical resolution to the pinned TypeScript checker, so nested blocks, parameters, closures, imports, classes, catch clauses, and control-flow scopes do not depend on backend name heuristics.
- TypeScript symbol and flow analysis runs on an internal syntax tree, preserving the caller-owned parsed source instead of leaking checker mutation across compiler passes.
- Local exports link to binding identity, semantic renames preserve that identity, and backends map the stable ID to the current declaration spelling. A rename therefore updates internal references without mutating source provenance.
- Cross-target golden and focused backend tests distinguish a local named `undefined` from the ambient value, while the existing explicit ambient-nullability refusal remains locked.
- Interface, type-alias, type-parameter, and type-only-import declarations introduce a distinct type-space identity; classes, enums, and ordinary imports intentionally retain their dual-space value identity when referenced as types.
- Named types and `typeof` queries distinguish resolved binding roots from ambient names and preserve qualified member paths separately. Shadowed type parameters therefore resolve by symbol rather than spelling, while standard ambient types remain eligible for explicit backend mappings.
- Target-name allocation covers value and type introductions in one deterministic target namespace. Haxe and Rust backends use the allocated identity for declarations, imports, type parameters, and type references, including collisions introduced by target case or keyword normalization.
- A versioned target-neutral static-fact vocabulary distinguishes truthiness source context and value domain, logical-expression operator and complete domain tuple, numeric relation domain, and indexed read/write mode without naming a target runtime operation.
- Element access preserves a non-empty normalized set of source receiver identities, including mutable or readonly arrays, every standard numeric typed-array family, strings, structural objects, and unknown receivers. Union aliases retain their members instead of introducing target-specific compound names.
- Typed-array `set` calls carry their exact normalized receiver set only when checker and declaration evidence classifies every possible receiver as a typed array; an ordinary array or object member with the same spelling remains an ordinary call.
- Typed-array element widths are neutral source facts. The static audit reports writes through receiver unions with distinct fixed widths while retaining their exact receiver and width sets; equal-width alternatives, open array unions, reads, and deletes do not acquire a target escape policy.
- Static-fact audits compose by fact identity and preserve deterministic ordering, module counts, schema identity, and caller-owned inputs. Empty composition is the identity and nested composition is associative, so orchestration can aggregate module or package audits without rewalking IR.

Open foundation work:

- The neutral IR is an initial coverage-driven model, not yet a reviewed complete vocabulary.
- Operator semantics now preserve static primitive operand and result domains, but target lowering for coercive, nullable, bigint, symbol, object, and uncertain-domain operations remains intentionally incomplete.
- Structural member names and qualified type-reference member paths remain textual. Member identity should be introduced only when a demonstrated lowering or patch operation must distinguish declarations beyond their resolved root symbol.
- Declaration merging is not yet represented as an explicit neutral operation; a future corpus-driven slice must choose whether to merge supported declarations during semantic lowering or reject the shape with a structured diagnostic.
- There is no versioned serialization/parser boundary for persisted IR; adding one prematurely would freeze the provisional model.
- Contract tests prove representative composition but do not yet exhaust every discriminated family.

Decision: do not declare the IR stable or publish a serialized IR format. Source, module, export, source-location, source-origin, value/type binding, emitted-file, semantic-patch target, and target-name identity, together with diagnostic and bedrock failure contracts, are now locked as readonly structural contracts. Declaration, type, type-directed expression-operator, and binding families now have a reviewed structural floor. Audit inventory next as the first composition above these primitives before widening target emission.

### `compiler-provenance`

Status: narrow and near-mature after the current hardening pass.

Strengths:

- It has no internal compiler dependency.
- SHA-256 identity is explicit and deterministic.
- TypeScript's parsed syntax tree, rather than text-wide regular expressions, defines node normalization.

This pass locks down an explicit normalization schema and TypeScript-version boundary, comment/format equivalence, literal and regular-expression counterexamples, source-path and line-ending independence, node fingerprint stability, and raw-text sensitivity. A TypeScript compiler upgrade deliberately changes the normalized identity prefix and therefore requires a patch-fingerprint review. Further expansion should happen only when inventory demonstrates another identity primitive is necessary.

### `compiler-patch`

Status: narrow and substantially mature after the current hardening pass.

Strengths:

- Patch targets carry package, source, export, kind, and expected fingerprint identity.
- Application clones input, orders neutral work before backend work, and emits a versioned audit.
- Inactive backend patches remain visible as skipped rather than disappearing.

This pass makes patch target fields self-identifying, gives every expected and defensive invariant failure a stable code and guard, covers all four operations, exercises ambiguity/conflict/staleness/kind failures, and proves input immutability. A future change should add an explicit patch-document parser only when patches are loaded from untyped external data; the in-memory typed constructor does not justify one yet.

### `compiler-emission`

Status: narrow and substantially mature after the current hardening pass.

Strengths:

- Output paths and contents are normalized at one seam.
- Backend and compiler-invariant failures are tagged plain `Error` records.
- Emitted files remain target-neutral plain data.

This pass gives path identity its own normalization primitive, canonicalizes separators and Unicode composition idempotently, and rejects POSIX, Windows drive, UNC, traversal, empty-segment, reserved-device, invalid-character, trailing-dot/space, and control-character paths. Content normalization is a separate primitive with a single final-newline contract. Backend failures carry a stable code and global package/source identity, guards validate structurally, and orchestration rejects exact, case-only, and Unicode-equivalent path collisions across the complete emitted set. Target names are allocated from stable binding IDs within explicit lexical and target namespaces; preferred spellings are reserved before deterministic suffixing, Unicode-equivalent spellings collide, input order cannot choose the winner, and invalid or duplicate candidate identities fail through stable invariant codes.

## Package isolation review

Each workspace passes its own strict typecheck and Vitest target. The package boundary remains justified only where the subject and dependency direction are independently useful:

| Package | Isolation conclusion | Current robustness boundary |
| --- | --- | --- |
| `compiler-types` | Keep independent as the dependency-free vocabulary floor. | Strict typecheck and focused composition tests cover useful relationships; identity, declaration/type separation and cardinality, closed operator tokens and static value domains, source location, value/type binding provenance, diagnostics/failures, and readonly collection boundaries are explicit, while declaration merging and complete expression/statement coverage remain open. |
| `compiler-provenance` | Keep independent as one narrow identity primitive. | Equivalence, counterexample, empty, Unicode, path, line-ending, raw-text, and TypeScript-version behavior are locked. |
| `compiler-patch` | Keep independent because patch identity and auditing are a separate lifecycle. | All operations and failure codes, deterministic ordering, backend skipping, and caller-input immutability are exercised. |
| `compiler-emission` | Keep independent as the portable emitted-file and backend-failure seam. | Path/content normalization, host-path rejection, portable path and target-name collision identity, lexical allocation scopes, indentation boundaries, and tagged failure guards are exercised. |
| `compiler-inventory` | Keep independent as the first read-only composition above identity. | Package discovery yields validated, portable, deterministically ordered manifest, dependency, bin, production-import, host-module, evidence-backed tooling-exclusion, and checker-resolved production host-endpoint facts; every manifest, project, Git, export-graph, source-resolution, runtime-classification, SDK, endpoint-receiver, and exclusion failure is tagged for message-independent handling. Host receiver classification enters through an explicit neutral capability; target runtime implementation coverage remains downstream. |
| `compiler-semantic` | Keep together for now; it owns TypeScript-to-neutral lowering and analysis over that neutral model. | Deterministic TypeScript-backed value bindings, operator value-domain analysis, normalized indexed receiver sets, and a versioned immutable static-fact audit cover truthiness, numeric relations, indexed access, typed-array set calls, and mixed-width indexed writes across every IR container; most production Flight semantics remain unported. |
| `compiler-backend-hx` | Keep together; naming was split into a focused sibling source, not a workspace. | Package/module identity, collision-free value/type binding allocation, keyword and case normalization, ambient-versus-bound references, and direct-versus-coercive operator decisions are direct-tested; production lowering and byte-stable parity remain open. |
| `compiler-backend-rs` | Keep together; naming and Rust keyword identity are focused sibling primitives. | Package/module identity, collision-free value/type binding allocation, keyword and case normalization, identity-based declarations/references, and direct-versus-lowered operator decisions are covered; ownership and production parity remain open. |
| `compiler-orchestration` | Keep independent as deterministic pass composition. | Duplicate identities and paths, diagnostics, patch flow, normalization, ordering, and input immutability are exercised. |
| `tool-compiler` | Keep as the only public workspace and dependency assembly boundary. | The facade and packed artifact are checked; its final downstream request/result contract is not frozen. |

No new workspace follows from this review. A large file alone is not a package domain. Split another flat sibling source when it owns a stable concept with a direct test; create another `compiler-*` workspace only when that concept also needs an independent dependency or lifecycle boundary. In particular, do not split target lowering from target emission until an explicit target model exists between them, and do not split semantic syntax families merely to export provisional helper APIs.

## Bedrock-first work order

1. Review and lock source, declaration, patch, module, and emitted-file identity contracts in `compiler-types`.
2. Finish the equivalence and collision model in `compiler-provenance`; add primitives only for demonstrated identity needs.
3. Finish semantic patch failure and audit contracts, then decide whether patches need a versioned untyped document format.
4. Finish emission path/content invariants and backend failure contracts.
5. Audit inventory as the first composition above bedrock: package discovery, export lanes, runtime bindings, host facts, exclusions, and deterministic reports.
6. Audit semantic IR families one at a time. Declaration, type, type-directed expression-operator, and value/type binding families now have a reviewed floor; expand them only from a demonstrated inventory or parity need.
7. Only then expand orchestration and target backends, using downstream parity as verification of the stable primitives rather than as their design source.

The semantic-fact batch completed three bounded iterations:

1. Distinguish conditional-expression, control-flow-condition, logical-operand, and negation-operand truthiness sites.
2. Record logical-expression operators and operand/result domains separately from truthiness use.
3. Compose version-matched static-fact audits deterministically without revisiting their source modules.

The current inventory-decomposition batch proceeds in three bounded iterations:

1. Isolate package export-lane lookup and specifier resolution.
2. Isolate Git checkout revision identity.
3. Isolate package export-map parsing and source-barrel validation.

## Freeze rule

“Mature” means the primitive is boring: narrow, unsurprising, and difficult to misuse. It does not mean the file may never change. A mature primitive can gain a new, orthogonal capability when a higher layer proves the need, but existing meaning changes only with an explicit contract review and regression demonstrating why the old meaning was wrong.
