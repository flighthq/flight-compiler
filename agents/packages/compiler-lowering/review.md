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
