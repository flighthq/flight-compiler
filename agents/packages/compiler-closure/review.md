---
package: '@flighthq/compiler-closure'
status: solid
score: 70
updated: 2026-08-22
ingested:
  - source
  - agents/compiler-foundations.md
---

# compiler-closure — Review

Representation-free evidence about closures: what each one captures, how the captured binding is used, whether it escapes, and how long it must live. ~680 lines in one analysis over the shared traversal, 6 table-driven tests.

## Verdict

**solid — 70/100.** The evidence model is the right one and it is deliberately representation-free — it says what is true about a capture without deciding how a target stores it, which is exactly the boundary Rust ownership and Haxe closure emission both need to sit above. The score reflects that this is evidence with no consumer: nothing elects a representation from it yet, so its correctness is currently proven only against its own fixtures rather than against emitted code that depends on it.

## What a fully expressed closure-evidence domain looks like

- Every closure origin located with a stable path, including nested and expression closures. Present.
- Per-capture evidence: which binding, how it is used, whether it is read, written, or rebound. Present.
- Mutation relation in both directions — the closure mutating the outer binding, and the outside mutating what the closure observes. Present.
- Escape analysis, distinguishing a proven escape from a conservative one. Present.
- Lifetime boundaries: module, per-iteration, escape, suspension. Present.
- `this` capture distinguishing lexical from dynamic. Present.
- No target representation: no boxing decision, no `Rc`, no `Ref`, no environment layout. Present, deliberately.
- A consumer that elects a representation from the evidence. Absent.

## Present capabilities

- **Per-iteration lifetime is modelled.** The classic `for (let i …)` capture — where each iteration must see its own binding — is a distinct lifetime boundary rather than an emitter special case. Getting this wrong produces code that compiles and returns the wrong answer, which is the worst failure class this repository has had before.
- **Capture use is classified, not just detected.** Read, write and rebinding are distinct, which is the input a target needs to choose between borrowing, owning and sharing.
- **Both mutation directions.** A closure that mutates a captured binding and an outer scope that mutates a binding the closure observes are different obligations; conflating them is how a shared-mutable capture becomes a silent copy.
- **Conservative escape is labelled as conservative**, so a consumer can tell a proven escape from an assumed one rather than treating an over-approximation as fact.
- **Suspension is a lifetime boundary**, which is what connects this package to `compiler-task`: a capture that must survive an `await` is a different obligation from one that does not.
- **Reads through the shared traversal** rather than a private walk, so a new IR kind cannot be silently skipped here.

## Gaps

- **No consumer elects a representation.** Rust ownership — the largest single gap in the repository — is exactly the decision this evidence exists to inform, and the Rust backend does not yet consume it. Until it does, the evidence is unfalsified by anything except its own tests.
- **Six tests over ~680 lines.** They are table-driven and the foundations audit reports zero unreached arms, so this is not an untested package. It is a thinly _counterexampled_ one: the tests establish that the analysis reports what it should on shapes it handles, and there are few near-neighbours proving it does not over-report. Escape and mutation are precisely where an over-approximation is cheap to write and expensive to discover.
- **No cross-module capture story.** A closure exported and invoked elsewhere has captures whose lifetime depends on the importing module; the analysis is per-module.
- **Evidence is not addressed to a decision.** It reports facts; it does not name the obligations those facts create — "this capture must outlive its frame", "this capture must be uniquely owned". A target author reads facts and re-derives the obligation, which is the sort of gap that produces two backends inferring differently from the same evidence.
