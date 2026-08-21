# Compiler Foundations

## Purpose

This document defines the dependency floor of `@flighthq/tool-compiler` and the standard for calling a foundational package mature. It deliberately works from primitives toward integrations. Downstream parity remains necessary, but it is not allowed to freeze weak vocabulary or accidental behavior into the compiler core.

## Dependency floor

```text
compiler-canonical-form + compiler-types
  <- compiler-provenance

compiler-canonical-form + compiler-types
  <- compiler-emission
  <- compiler-runtime-contract

compiler-canonical-form + compiler-provenance + compiler-types
  <- compiler-patch

compiler-provenance + compiler-types
  <- compiler-ir-validation

compiler-ir-validation + compiler-types
  <- compiler-lowering

compiler-canonical-form + compiler-types + compiler-provenance
  <- compiler-inventory

compiler-canonical-form + compiler-ir-traversal + compiler-provenance + compiler-structural + compiler-types
  <- compiler-semantic

compiler-canonical-form + compiler-ir-traversal + compiler-types
  <- compiler-structural

compiler-types + compiler-emission + compiler-lowering + compiler-runtime-contract
  <- compiler-backend-hx

compiler-types + compiler-emission + compiler-lowering + compiler-runtime-contract + compiler-structural
  <- compiler-backend-rs

canonical form + types + semantic + patch + emission
  <- compiler-orchestration
  <- tool-compiler
```

The first five packages are the bedrock review set:

1. `compiler-types` is the vocabulary, not an implementation utility package.
2. `compiler-canonical-form` defines host-independent text order and portable path form without owning domain identity policy.
3. `compiler-provenance` answers whether two source identities are the same.
4. `compiler-patch` applies explicit, fingerprint-bound changes and records what happened.
5. `compiler-emission` defines portable output and inspectable backend/invariant failures.

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
- Object expressions preserve ordered members and distinguish ordinary construction from spread-bearing construction through an exact target-neutral copy-semantics contract.
- Class constructors distinguish absence from an explicit empty constructor; class and interface heritage accepts named type references rather than arbitrary types.
- Class constructors retain ordered overload signatures separately from one executable implementation, while every resolved invocation distinguishes selected overload arity, implementation ABI arity, final rest position, and exact static-or-dynamic argument count. Fixed extra arguments on direct calls are evaluated left-to-right into source-identified carriers before target-neutral erasure; receiver-bearing, optional-chain, spread, and explicit-undefined default cases remain explicit refusals until a semantics-preserving transform owns them.
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
- Target-name allocation covers value and type introductions in one deterministic target namespace. Haxe and Rust backends use the allocated identity for declarations, imports, type parameters, and type references. Internal bindings are renamable when target case or keyword normalization collides; public declarations keep their preferred target spelling, win over internal collisions, and fail with a tagged allocation refusal when two fixed spellings collide.
- A versioned target-neutral static-fact vocabulary distinguishes truthiness source context and value domain, logical-expression operator and complete domain tuple, numeric relation domain, numeric arithmetic operation/operator and declared-versus-flow operand domains, and indexed read/write mode without naming a target runtime operation.
- Element access preserves a non-empty normalized set of source receiver identities, including mutable or readonly arrays, every standard numeric typed-array family, strings, structural objects, and unknown receivers. Union aliases retain their members instead of introducing target-specific compound names.
- Typed-array `set` calls carry their exact normalized receiver set only when checker and declaration evidence classifies every possible receiver as a typed array; an ordinary array or object member with the same spelling remains an ordinary call.
- Typed-array element widths are neutral source facts. The static audit reports writes through receiver unions with distinct fixed widths while retaining their exact receiver and width sets; equal-width alternatives, open array unions, reads, and deletes do not acquire a target escape policy.
- Static-fact audits compose by fact identity and preserve deterministic ordering, module counts, schema identity, and caller-owned inputs. Empty composition is the identity and nested composition is associative, so orchestration can aggregate module or package audits without rewalking IR.

Open foundation work:

- The neutral IR is an initial coverage-driven model, not yet a reviewed complete vocabulary.
- Operator semantics preserve declared and flow-sensitive primitive operand domains separately from result domains. Numeric arithmetic audits retain that evidence by operation and operator, but target lowering for coercive, nullable, bigint, symbol, object, and uncertain-domain operations remains intentionally incomplete.
- Structural member names and qualified type-reference member paths remain textual. Member identity should be introduced only when a demonstrated lowering or patch operation must distinguish declarations beyond their resolved root symbol.
- Declaration merging is not yet represented as an explicit neutral operation; a future corpus-driven slice must choose whether to merge supported declarations during semantic lowering or reject the shape with a structured diagnostic.
- There is no versioned serialization/parser boundary for persisted IR; adding one prematurely would freeze the provisional model.
- Contract tests prove representative composition but do not yet exhaust every discriminated family.

Decision: do not declare the IR stable or publish a serialized IR format. Source, module, export, source-location, source-origin, value/type binding, emitted-file, semantic-patch target, and target-name identity, together with diagnostic and bedrock failure contracts, are now locked as readonly structural contracts. Declaration, type, type-directed expression-operator, and binding families now have a reviewed structural floor. Audit inventory next as the first composition above these primitives before widening target emission.

### `compiler-provenance`

Status: narrow and near-mature after the current hardening pass.

Strengths:

- It depends only on the shared contract and deterministic canonical-form floors.
- SHA-256 identity is explicit and deterministic.
- TypeScript's parsed syntax tree, rather than text-wide regular expressions, defines node normalization.

The current schema locks canonical syntax-kind names, compatibility aliases, comment/format equivalence, literal and regular-expression counterexamples, source-path and line-ending independence, node fingerprint stability, raw-text sensitivity, and exact lowercase SHA-256 runtime shape. TypeScript package versions and numeric enum values do not enter identity; a deliberate normalization change requires a schema bump and patch-fingerprint review. Further expansion should happen only when inventory demonstrates another identity primitive is necessary.

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

This pass gives path identity its own normalization primitive, canonicalizes separators and Unicode composition idempotently, and rejects POSIX, Windows drive, UNC, traversal, empty-segment, reserved-device, invalid-character, trailing-dot/space, and control-character paths. Content normalization preserves source whitespace while canonicalizing LF transport and one final newline; leading BOMs and unpaired surrogates refuse before exact BOM-free UTF-8 encoding. Backend failures carry a stable code and global package/source identity, guards validate structurally, and orchestration rejects exact, case-only, and Unicode-equivalent path collisions across the complete emitted set. Target names are allocated from stable binding IDs within explicit lexical and target namespaces; preferred spellings are reserved before deterministic suffixing, Unicode-equivalent spellings collide, and input order cannot choose the winner. Fixed public spellings take precedence over renamable internal bindings, two fixed collisions fail through a tagged allocation contract, and invalid or duplicate candidate identities fail through stable invariant codes. Haxe and Rust share a generated-file provenance primitive that always names the global input identity and includes a validated inventory commit when supplied. Emitted-source syntax is parser-injected and per-file: the compiler normalizes and freezes supported files, canonicalizes and orders one-based diagnostics, reports deterministically ordered skipped paths, rejects malformed adapters through stable invariant codes, and lets orchestration enforce syntax before returning output. Downstream target compilation is a separate batch adapter over the complete normalized supported file set, with its own diagnostics, failure identity, and non-vacuity gate; a syntax parser can never satisfy that stronger claim. Haxe and Rust own exact-extension shapes for both adapters. `flight-hx` and `flight-rs` supply the real parser and compiler callbacks and continue to own compiler installation, runtime support, and project assembly.

### `compiler-structural`

Status: narrow and deliberately provisional while structural lowering grows.

The package gives closed anonymous object types a versioned target-neutral identity without putting domain policy into `compiler-canonical-form`. Property and compound-member ordering do not affect identity, while optionality, readonly state, tuple/parameter cardinality, nominal roots, literal code points, and numeric `-0` remain distinct. Locally bound function type parameters are alpha-equivalent; unrelated outer type parameters remain nominal. A deterministic immutable inventory coalesces identical nested shapes across modules and retains every module plus traversal-path occurrence. Duplicate property names, cyclic runtime values, and non-finite numeric literal types fail through a stable tagged contract. Rust anonymous and object-rest record interning now consumes this shared identity.

Spread-bearing object expressions carry an independently constructed immutable copy-semantics record. It locks JavaScript's left-to-right single evaluation, nullish skipping, own enumerable string-and-symbol key set, one `Get` per key in own-key order, `CreateDataProperty` target writes, and later-value replacement without changing an existing key position. Semantic lowering retains the ordered source operations—including duplicate writes and computed key-before-value effects—and structural IR validation requires exact semantics if and only if an object contains spread. Both backends continue to refuse source emission until they can implement the complete contract; shared nominal storage emission, generic structural construction, target copy representation, and compatibility diagnostics remain separate decisions.

## Package isolation review

Each workspace passes its own strict typecheck and Vitest target. The package boundary remains justified only where the subject and dependency direction are independently useful:

| Package | Isolation conclusion | Current robustness boundary |
| --- | --- | --- |
| `compiler-types` | Keep independent as the dependency-free vocabulary floor. | Strict typecheck and focused composition tests cover useful relationships; identity, declaration/type separation and cardinality, closed operator tokens and static value domains, source location, value/type binding provenance, diagnostics/failures, and readonly collection boundaries are explicit, while declaration merging and complete expression/statement coverage remain open. |
| `compiler-canonical-form` | Keep independent as the dependency-free host-independent canonical-form floor. | Exact text equality and order, empty and prefix values, ASCII case, non-ASCII and surrogate text, antisymmetry, transitivity, caller-owned Unicode normalization, and portable separator form are direct-tested; package health prevents local comparator, locale-sensitive ordering, and path-form regressions. |
| `compiler-provenance` | Keep independent as one narrow identity primitive. | Equivalence, counterexample, empty, Unicode, path, line-ending, raw-text, and TypeScript-version behavior are locked. |
| `compiler-patch` | Keep independent because patch identity and auditing are a separate lifecycle. | All operations and failure codes, deterministic ordering, backend skipping, and caller-input immutability are exercised. |
| `compiler-emission` | Keep independent as the portable emitted-file and backend-failure seam. | Path/content normalization, host-path rejection, portable path and target-name collision identity, fixed-versus-renamable lexical allocation, per-file parser syntax checks, batch target compilation smoke checks, indentation boundaries, and tagged failure guards are exercised. |
| `compiler-ir-validation` | Keep independent as the structural and lexical integrity boundary for target-neutral IR values. | Module and binding identity, legal introduction roles, exact source fingerprints, ancestor-scope reachability across module/declaration/function/block regions, compound-type arity, parameter cardinality, and every discriminated IR family are checked without target policy or mutation. |
| `compiler-lowering` | Keep independent as the backend-elected library of neutral IR-to-IR transforms. | Pass ordering, shared structural validation, pass-specific postconditions, explicit idempotence verification, module identity, immutability, stable pass-named failures, initializer scope, omitted conditions, discarded numeric updates, and continue-correct nested-loop behavior are direct-tested with zero unreached arms. |
| `compiler-runtime-contract` | Keep independent as the target-neutral ambient-symbol and constructor-ABI completeness seam. | Exact type/value-space source identities and direct ambient constructor arities are collected across reachable IR. Symbol bindings and constructor ABIs have independent versioned plans; duplicate, invalid, missing, fixed, and dynamic constructor decisions are deterministic, while target names and runtime implementations stay out. |
| `compiler-structural` | Keep independent as structural type identity and analysis above canonical form. | Closed object identity, every IR type family, property/compound order equivalence, semantic counterexamples, generic alpha-equivalence, tagged malformed-input failures, deterministic cross-module occurrence inventory, immutable object-copy semantics, empty input, and Rust interning reuse are covered; shared nominal storage, target copy representation, and compatibility policy remain open. |
| `compiler-inventory` | Keep independent as the first read-only composition above identity. | Package discovery yields validated, portable, deterministically ordered manifest, dependency, bin, production-import, host-module, evidence-backed tooling-exclusion, and checker-resolved production host-endpoint facts; every manifest, project, Git, export-graph, source-resolution, runtime-classification, SDK, endpoint-receiver, and exclusion failure is tagged for message-independent handling. Host receiver classification enters through an explicit neutral capability; target runtime implementation coverage remains downstream. |
| `compiler-semantic` | Keep together for now; it owns TypeScript-to-neutral lowering and analysis over that neutral model. | Deterministic TypeScript-backed value bindings, declared-versus-flow operator domains, normalized indexed receiver sets, and a versioned immutable static-fact audit cover truthiness, numeric relations and arithmetic, indexed access, typed-array set calls, and mixed-width indexed writes across every IR container; most production Flight semantics remain unported. |
| `compiler-backend-hx` | Keep together; naming was split into a focused sibling source, not a workspace. | Package/module identity, collision-free value/type binding allocation, keyword and case normalization, ambient-versus-bound references, and direct-versus-coercive operator decisions are direct-tested; production lowering and byte-stable parity remain open. |
| `compiler-backend-rs` | Keep together; naming and Rust keyword identity are focused sibling primitives. | Package/module identity, collision-free value/type binding allocation, keyword and case normalization, identity-based declarations/references, and direct-versus-lowered operator decisions are covered; ownership and production parity remain open. |
| `compiler-orchestration` | Keep independent as deterministic pass composition. | Duplicate identities and paths, diagnostics, patch flow, ordered optional syntax-parser and target-compiler smoke enforcement, normalization, ordering, non-vacuity, and input immutability are exercised. |
| `tool-compiler` | Keep as the only public workspace and dependency assembly boundary. | The facade and packed artifact are checked; its final downstream request/result contract is not frozen. |

The current isolation review created `compiler-lowering` only after cross-target refusals demonstrated an independent dependency and lifecycle boundary. A large file alone is still not a package domain. Split another flat sibling source when it owns a stable concept with a direct test; create another `compiler-*` workspace only when that concept also needs an independent dependency or lifecycle boundary. Target naming, ecosystem policy, and source emission remain backend concerns.

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

The inventory-decomposition batch completed three bounded iterations:

1. Isolate package export-lane lookup and specifier resolution.
2. Isolate Git checkout revision identity.
3. Isolate package export-map parsing and source-barrel validation.

The deterministic-ordering batch completed three bounded iterations:

1. Remove host-locale ordering from inventory facts and reports.
2. Remove host-locale ordering from semantic patch selection and audits.
3. Remove host-locale ordering from orchestration modules, diagnostics, and emitted output.

The semantic-numeric batch completed three bounded iterations:

1. Introduce a named declared-versus-flow operand-domain contract and migrate operator semantics without changing backend behavior.
2. Populate declared and flow domains from checker evidence, including explicitly typed unions narrowed at an operation site.
3. Audit numeric arithmetic operations by operator and declared/flow domains so target backends can identify narrowed storage without target policy in the neutral IR.

The control-flow-lowering batch completed three bounded iterations:

1. Define pure `IrModule`-to-`IrModule` pass records with declared ordering, output verification, idempotence checks, caller-input immutability, and stable pass-named failures.
2. Normalize C-style `for` statements while preserving initializer scope, omitted conditions, discarded numeric updates, and continue ownership across nested loops, switches, and `finally` boundaries.
3. Have Haxe and Rust explicitly elect the pass, preserve target-specific default-parameter decisions, and lock direct and cross-target emitted output.

The patch-integrity batch completed three bounded iterations:

1. Validate every in-process patch definition through stable tagged failures, including exact provenance fingerprints and legal scope/operation payloads.
2. Version the selected backend and deterministic applied/skipped records in `flight-compiler-patch-audit/2`.
3. Reuse the application engine for `flight-compiler-patch-analysis/1` before/after snapshots without returning rewritten modules.

The runtime-contract batch completed three bounded iterations:

1. Define the versioned runtime capability and external-type binding vocabulary in `compiler-types`, including a deterministic completeness result that names every missing decision.
2. Implement the target-neutral completeness check over reachable inventory identities in a narrow `compiler-runtime-contract` package, without owning target names or downstream runtime implementations.
3. Add explicit Haxe and Rust binding tables that elect direct native mapping or a versioned runtime capability per external type, and refuse emission before source generation when the elected table is incomplete.

The runtime-symbol batch completed three bounded iterations:

1. Generalize runtime identity and completeness from external type names to exact source-name plus type/value-space symbols under `flight-runtime-contract/2`.
2. Collect ambient value references through expressions and `typeof` queries, while preserving lexical shorthand-property bindings and excluding compiler intrinsics.
3. Make Haxe and Rust elect and emit space-specific native/runtime targets, with unknown values refused before source generation and static Rust members using associated-item syntax.

The IR-integrity batch completed three bounded iterations:

1. Make external-type reachability exhaustive at every declaration, expression, object-member, statement, and type discriminant boundary.
2. Add a dependency-floor structural `IrModule` validator with stable failure codes and paths for identity, provenance, binding references, arity, cardinality, and unknown runtime shapes.
3. Compose shared structure checks with lowering-pass postconditions, preserve module identity, and move repeated idempotence execution behind an explicit verification depth so ordinary backends transform once.

The deterministic-ordering consolidation batch completed three bounded iterations:

1. Define one dependency-free UTF-16 code-unit text order with executable equality, boundary, Unicode, antisymmetry, transitivity, and normalization-ownership laws.
2. Replace private ordering copies in patching, emission, and runtime-contract foundations while preserving each domain's normalization policy.
3. Replace the remaining inventory and orchestration copies, and make package health reject local named text comparators and locale-sensitive `localeCompare` calls.

The provenance-integrity batch completed three bounded iterations:

1. Move TypeScript node identity to canonical syntax-kind names under schema 2, excluding parser version, numeric enum values, range aliases, and renamed compatibility aliases from fingerprints.
2. Define `CompilerSourceFingerprint` across every fingerprint-bearing contract and an exact lowercase SHA-256 runtime guard in `compiler-provenance`.
3. Enforce exact source fingerprints in structural IR validation and prove lowering refuses a pass that corrupts provenance before its own postcondition runs.

The canonical-form batch completed three bounded iterations:

1. Rename the single-primitive `compiler-ordering` package to the durable `compiler-canonical-form` domain before more packages depend on it.
2. Define host-independent portable path separator form, migrate all ten production implementations across five packages, and preserve domain-owned Unicode, validation, and path-resolution policy.
3. Make package health reject local backslash, regular-expression, and current-host separator conversion; the planted old Haxe implementation fails by the guard's own diagnostic.

The latest five-iteration compiler ABI batch completed:

1. Propagate contextual structural-construction targets through nested records, arrays, tuples, aliases, conditional arms, non-null assertions, and parentheses.
2. Classify every provided default and optional argument as value, null, or undefined with exact argument and parameter type evidence.
3. Represent class method overloads as ordered analysis signatures beside exactly one body-bearing implementation, and represent interface method overload sets as callable intersections.
4. Version direct ambient constructor arities independently under `flight-runtime-constructor-abi/1`, with deterministic completeness and target-owned Haxe and Rust plans.
5. Separate per-file emitted-source syntax parsing from one downstream target compilation smoke over the complete normalized supported file set.

The active ten iterations, subject to recalibration after the first five, are:

1. **Complete:** give structurally equivalent shapes one canonical identity across module boundaries.
2. **Complete:** model object-spread copy order, overwrite behavior, and effect preservation in neutral lowering.
3. Preserve generic substitution through structural record construction and emission.
4. Produce structured structural-compatibility diagnostics rather than target-specific late failures.
5. Emit idiomatic Rust statement-value carriers without changing JavaScript completion semantics.
6. Model class field and constructor initialization order as a target-neutral plan.
7. Deepen class layout, inheritance, and implementation semantics from demonstrated source shapes.
8. Define async task completion and `await` semantics before either backend chooses runtime syntax.
9. Define thrown values, catch bindings, and `finally` completion replacement across targets.
10. Give module facades and re-export emission stable cross-module identity.

## Freeze rule

“Mature” means the primitive is boring: narrow, unsurprising, and difficult to misuse. It does not mean the file may never change. A mature primitive can gain a new, orthogonal capability when a higher layer proves the need, but existing meaning changes only with an explicit contract review and regression demonstrating why the old meaning was wrong.
