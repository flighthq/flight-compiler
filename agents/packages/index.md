# Package Reviews

One folder per package, following Flight's convention. Each `review.md` is a survey of source that answers one question: what would a reference, fully expressed version of this package's domain look like, and how much of that exists today.

A score is a judgement about **domain coverage**, not about code quality. `compiler-backend-rs` scores 34 and is well built; it simply has a very large domain and has expressed a small part of it. `compiler-provenance` scores 88 with 130 lines, because its domain is genuinely small and it has most of it. Read the score against the reference section in each file, never on its own.

| package | status | score | the domain in one line |
| --- | --- | --: | --- |
| [compiler-canonical-form](compiler-canonical-form/review.md) | mature | 96 | which bytes represent equivalent compiler text and paths across hosts |
| [compiler-emission](compiler-emission/review.md) | mature | 90 | portable generated-file identity, contents, and provenance |
| [compiler-patch](compiler-patch/review.md) | near-mature | 90 | correct upstream semantics without editing upstream |
| [compiler-provenance](compiler-provenance/review.md) | near-mature | 88 | are two pieces of source the same thing |
| [compiler-runtime-contract](compiler-runtime-contract/review.md) | near-mature | 86 | does every reachable ambient type/value symbol have one target binding decision |
| [compiler-ir-validation](compiler-ir-validation/review.md) | near-mature | 86 | is a target-neutral IR module structurally trustworthy |
| [compiler-task](compiler-task/review.md) | near-mature | 84 | what suspends, and what a target must supply to run it |
| [compiler-ir-traversal](compiler-ir-traversal/review.md) | near-mature | 82 | the one typed walk over an IR module |
| [compiler-completion](compiler-completion/review.md) | solid | 78 | how a statement finishes, and carrying what |
| [compiler-types](compiler-types/review.md) | foundational | 74 | the vocabulary everything else speaks |
| [compiler-structural](compiler-structural/review.md) | solid | 72 | when two shapes are the same, and what follows |
| [compiler-closure](compiler-closure/review.md) | solid | 70 | what a closure captures and how long it must live |
| [compiler-inventory](compiler-inventory/review.md) | solid | 68 | what is in this workspace and what does it export |
| [compiler-lowering](compiler-lowering/review.md) | solid | 64 | verified neutral IR-to-IR transforms elected by targets |
| [tool-compiler](tool-compiler/review.md) | solid | 62 | the one published artifact |
| [compiler-orchestration](compiler-orchestration/review.md) | solid | 60 | compose the passes deterministically |
| [compiler-semantic](compiler-semantic/review.md) | early | 58 | TypeScript in, neutral IR out |
| [compiler-module](compiler-module/review.md) | early | 55 | what links, in what order, and which slot a name means |
| [compiler-backend-hx](compiler-backend-hx/review.md) | early | 52 | neutral IR in, idiomatic Haxe out |
| [compiler-backend-rs](compiler-backend-rs/review.md) | early | 46 | neutral IR in, idiomatic Rust out |

All twenty packages now have a review. Fourteen were re-read against the merged tree on 2026-08-21; the six that arrived after that — traversal, completion, structural, closure, module, task — were reviewed on 2026-08-22. Facade work delivered in a parcel but not yet merged here is called out in the module review rather than scored.

## What the shape says

The scores fall into the dependency order almost exactly, and that is the intended result of building bedrock-first: the primitives are close to done, the compositions above them are solid, and the two target backends — the packages whose domains are the largest and whose correctness is hardest to establish — are the least expressed. Nothing here is out of order.

The three lowest scores are also the three packages that gate the migration. `compiler-semantic` at 58 bounds both backends: a construct it cannot lower cannot be emitted by either target, so its refusal list is the shared ceiling. Within the backends, the recurring theme is that structure and refusal discipline are ahead of coverage — both have their identity, naming and operator handling settled, and both refuse rather than approximate, which is why the golden fixtures can pin refusals as confidently as output.

## Three open decisions, recorded 2026-08-22

Work stopped at these rather than guessing, because each sets a policy rather than filling a gap.

- **An integer domain.** The neutral numeric domain has one member, `number`, so every numeric reaches a target as `Float` or `f64`. Haxe indexes arrays with `Int` and Rust with `usize`, so both targets now coerce at the use site. Coercion is correct and it is also everywhere; distinguishing integers in the neutral model would remove it, and the question is where integer-ness comes from when TypeScript has no integer type — literals and contexts, which is an inference policy.
- **Resolved operator assignability.** `compiler-structural` decides when two shapes are the same and when one is assignable to the other, but not what an operator over them yields. The operator work in `compiler-semantic` derives domains from operands; the structural counterpart is unwritten, and both targets refuse the cases it would decide.
- **Exact versus conservative completions.** `compiler-completion` reports a `throw` on essentially every statement, because essentially every statement can throw. That is sound and it is also uninformative: a backend cannot tell a proven throw from an assumed one, so it guards both. Saying which is which needs a second channel in the completion set, and a decision about what "proven" means for a call into unanalyzed code.

## Recurring gaps across packages

Six gaps appear in more than one review and are worth reading as one problem each rather than as several:

- **No serialization boundary anywhere.** The IR, the inventory report and the patch set are all in-process typed values. Nothing can cross a process, be cached, or be diffed by a tool that is not this compiler — which the oracle-vector and drift-tracking plans both eventually need.
- **No incrementality.** Inventory and orchestration both re-do whole-checkout work every run, and provenance re-walks every tree. Acceptable at present scale, and named before it is not.
- **Reporting is thinner than the work performed.** Orchestration counts files, inventory counts exports, and neither can say which declarations refused and why — which is the number the migration most needs and the one nothing currently produces.
- **The neutral pass library is no longer a single transform, but its second half is still absent.** `compiler-lowering` now elects four passes — the composite binding-pattern entry over array and object patterns, function-scoped variable hoisting with definite-assignment analysis, C-style `for`, and switch fallthrough — each validated structurally and by an independent residual postcondition. Every transform so far is a statement-shape transform; the expression side — async and task meaning, call-site and spread lowering, structural copy, general optional access, and target ownership — is unwritten, and every one of them is named by a refusal a golden fixture already pins. [The breadth analysis](../compiler-breadth.md) separates neutral reusable passes from target representation.
- **Pass election is uniform, though target divergence is real one layer down.** Both backends elect the identical six lowering passes in the identical order, and `runsAfter` is a hard requirement, so an elected set must be dependency-closed. Divergence in what targets do with the same neutral output is established — native default parameters in Haxe against a Rust refusal, a Rust block expression against a Haxe immediately-invoked function for the same statement-value carrier, a runtime-routed `Float32Array` in Haxe against a native `Vec<f32>` in Rust. What remains unproven is only that a backend can decline a pass its sibling elects.
- **No emitted-output verification.** The golden fixtures pin bytes, not validity. A fixture can pin invalid target source, and once did. Compiling emitted Haxe and Rust belongs downstream, but a parse-level check here would close the gap between "the bytes did not change" and "the bytes are correct".
