---
package: '@flighthq/compiler-lowering'
status: early
score: 48
updated: 2026-08-20
ingested:
  - source
  - agents/compiler-breadth.md
  - golden/
---

# compiler-lowering — Review

The backend-elected library for pure target-neutral IR-to-IR transforms. Its first implementation is intentionally narrow: a verified pass lifecycle and C-style `for` normalization used explicitly by both current targets.

## Verdict

**early — 48/100.** The framework is stronger than the score: pass identity and order are explicit, input is isolated, every output receives shared structural validation plus a pass-specific postcondition, module identity is preserved, and every branch is exercised. Declared idempotence is an explicit deep-verification mode rather than a production-time second transform. The domain is nevertheless early because only one of the neutral transformations already named by backend refusals exists.

## What a fully expressed lowering library looks like

- Plain `IrModule`-to-`IrModule` pass records with stable identity and dependency order. Present.
- Backend election, so a target keeps native semantics when lowering would make its output less idiomatic. Present for C-style `for`; default-parameter asymmetry proves the boundary.
- Structural and pass-specific verification after every transform, with declared idempotence available as an explicit audit. Present.
- Stable pass-named failures for malformed input, unsupported semantics, invalid order, execution failure, and false idempotence claims. Present.
- One focused, target-neutral source and matching direct test per transform. Present structurally; only one transform exists.
- Control-flow transforms that preserve completion behavior across `break`, `continue`, `return`, `throw`, nested loops, switches, and `finally`.
- Expression and call-site transforms that preserve evaluation order, receiver identity, aliasing, and value-versus-discarded context.
- No filesystem, TypeScript checker, target syntax, runtime implementation, or mandatory orchestration stage. Present.

## Present capabilities

- **Verified pass execution.** Duplicate names, reversed declared order, and unknown verification depth fail before work begins. Each output passes the target-neutral structural validator and its pass-specific postcondition, and every pass must preserve module identity.
- **Explicit verification cost.** Ordinary backend execution transforms once. An explicit idempotence depth reapplies a pass that declares idempotence, validates both outputs, and compares them structurally. A malformed verifier result fails as pass execution rather than being mistaken for success.
- **Caller isolation and determinism.** The runner and concrete pass clone caller input. Repeated plans yield equivalent output, including failure identity and message.
- **Continue-correct C-style loops.** Initializers remain scoped inside a block, an omitted condition becomes `true`, and discarded numeric increment/decrement updates become compound assignment usable by both targets.
- **Loop ownership.** A continue targeting the transformed loop runs the update first; a continue owned by a nested `while`, `do`, `for-in`, `for-of`, or nested C-style loop does not acquire the outer update. Switch-contained continues retain the surrounding loop target.
- **Completion safety.** A continue crossing `finally` refuses with a pass-named unsupported-IR failure instead of silently changing observable order. A nested loop inside the same try body remains independent.
- **Explicit target election.** Haxe and Rust call the pass library themselves. Haxe continues to emit native default parameters while Rust keeps its call-site-lowering refusal.

## Gaps

- Only C-style `for` normalization exists. Switch fallthrough, destructuring, spread, default arguments, optional access, async suspension, and structural-copy transforms remain absent.
- The loop pass refuses a continue that crosses `finally`; completion-record lowering must exist before that source shape can be emitted.
- BigInt update expressions remain as unary updates because the neutral IR cannot yet express a BigInt literal operand for a compound assignment. Rust therefore still needs value/domain-aware lowering for that case.
- Pass order is validated from direct `runsAfter` names but has no separate reusable plan artifact or explanation report. Add one only when multiple elected passes make plan inspection useful.
- The public facade exposes the concrete pass and generic runner before a downstream consumer exists. Their shapes should remain provisional until Haxe adoption exercises selection and diagnostics through the packed artifact.
- Structural validity and a pass postcondition cannot prove general before/after semantic equivalence. Each new transform still needs construct-specific preservation tests and target parity evidence.

## Reviewer findings — the lexical-integrity batch

Read from the delivered diff; I could not execute either point, because the binding-scope vocabulary it rests on is newer than my tree.

- **A function-scoped declaration inside a block has no pass that makes it emittable.** `IrBindingScope` now carries `block | declaration | function | module`, and semantic lowering classifies `var` as `function` and `let`/`const` as `block` from `ts.NodeFlags.BlockScoped`. The validator uses that correctly: a `var` declared inside a block and referenced after it is _valid_ IR, because it is valid JavaScript. But `binding.scope` is read only by the validator that checks it and the lowering that produces it — **neither backend consumes it**. Haxe and Rust have no `var`: a declaration emitted inside a block is block-scoped in both, so the later reference is out of scope in the emitted source. The validator's own fixture is exactly this shape (`{ var hoisted = total; } total += hoisted;`), so it is representable, accepted, and emittable today. The general fix is a neutral pass that hoists function-scoped declarations to their owning function — precisely this package's job, and a sibling of the C-style `for` pass, which _creates_ this shape by wrapping a loop initializer in a block. Until that exists, a backend refusal on a `function`-scoped binding introduced inside a block matches the posture used everywhere else here: refuse rather than emit something the target cannot mean.

- **Structural validation is unconditional per pass, while the idempotence audit is opt-in.** That asymmetry is defensible — validation is the only guard against a pass corrupting the IR, and running it per pass is what lets the failure name the responsible pass. The cost is worth stating as a curve rather than a defect: it is one full validating walk _per pass, per module, per target_, and every intermediate module is validated although only the last is emitted. With one elected pass that is negligible. The roadmap in this review names seven more (switch fallthrough, destructuring, spread, default arguments, optional access, async suspension, structural copy), and both backends run the plan, so the same invariants over the same module get re-proved on the order of fifteen times. Attribution is what that buys; if it ever stops being worth it, validating once after the plan and once on input is the cheaper shape that keeps the guarantee and loses only the pass name.
