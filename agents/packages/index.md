# Package Reviews

One folder per package, following Flight's convention. Each `review.md` is a survey of source that answers one question: what would a reference, fully expressed version of this package's domain look like, and how much of that exists today.

A score is a judgement about **domain coverage**, not about code quality. `compiler-backend-rs` scores 26 and is well built; it simply has a very large domain and has expressed a small part of it. `compiler-provenance` scores 82 with 130 lines, because its domain is genuinely small and it has most of it. Read the score against the reference section in each file, never on its own.

| package | status | score | the domain in one line |
| --- | --- | --: | --- |
| [compiler-ordering](compiler-ordering/review.md) | near-mature | 90 | in what host-independent order should compiler text appear |
| [compiler-provenance](compiler-provenance/review.md) | near-mature | 88 | are two pieces of source the same thing |
| [compiler-emission](compiler-emission/review.md) | near-mature | 80 | what may a generated file and a generated name be called |
| [compiler-patch](compiler-patch/review.md) | substantially-mature | 78 | correct upstream semantics without editing upstream |
| [compiler-types](compiler-types/review.md) | foundational | 72 | the vocabulary everything else speaks |
| [compiler-runtime-contract](compiler-runtime-contract/review.md) | solid | 70 | does every reachable external type have one target binding decision |
| [compiler-ir-validation](compiler-ir-validation/review.md) | solid | 72 | is a target-neutral IR module structurally trustworthy |
| [compiler-inventory](compiler-inventory/review.md) | solid | 68 | what is in this workspace and what does it export |
| [tool-compiler](tool-compiler/review.md) | solid | 62 | the one published artifact |
| [compiler-orchestration](compiler-orchestration/review.md) | solid | 60 | compose the passes deterministically |
| [compiler-lowering](compiler-lowering/review.md) | early | 48 | verified neutral IR-to-IR transforms elected by targets |
| [compiler-semantic](compiler-semantic/review.md) | early | 38 | TypeScript in, neutral IR out |
| [compiler-backend-hx](compiler-backend-hx/review.md) | early | 30 | neutral IR in, idiomatic Haxe out |
| [compiler-backend-rs](compiler-backend-rs/review.md) | early | 26 | neutral IR in, idiomatic Rust out |

## What the shape says

The scores fall into the dependency order almost exactly, and that is the intended result of building bedrock-first: the primitives are close to done, the compositions above them are solid, and the two target backends — the packages whose domains are the largest and whose correctness is hardest to establish — are the least expressed. Nothing here is out of order.

The three lowest scores are also the three packages that gate the migration. `compiler-semantic` at 38 bounds both backends: a construct it cannot lower cannot be emitted by either target, so its refusal list is the shared ceiling. Within the backends, the recurring theme is that structure and refusal discipline are ahead of coverage — both have their identity, naming and operator handling settled, and both refuse rather than approximate, which is why the golden fixtures can pin refusals as confidently as output.

## Recurring gaps across packages

Five gaps appear in more than one review and are worth reading as one problem each rather than as several:

- **No serialization boundary anywhere.** The IR, the inventory report and the patch set are all in-process typed values. Nothing can cross a process, be cached, or be diffed by a tool that is not this compiler — which the oracle-vector and drift-tracking plans both eventually need.
- **No incrementality.** Inventory and orchestration both re-do whole-checkout work every run, and provenance re-walks every tree. Acceptable at present scale, and named before it is not.
- **Reporting is thinner than the work performed.** Orchestration counts files, inventory counts exports, and neither can say which declarations refused and why — which is the number the migration most needs and the one nothing currently produces.
- **Most lowering passes named by refusals are still absent.** The first shared control-flow transform now has a verified, backend-elected home in `compiler-lowering`; async, call-site, spread, structural-copy, option-aware, and target ownership work remain. [The breadth analysis](../compiler-breadth.md) separates neutral reusable passes from target representation.
- **No emitted-output verification.** The golden fixtures pin bytes, not validity. A fixture can pin invalid target source, and once did. Compiling emitted Haxe and Rust belongs downstream, but a parse-level check here would close the gap between "the bytes did not change" and "the bytes are correct".
