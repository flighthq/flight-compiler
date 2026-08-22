---
package: '@flighthq/compiler-completion'
status: solid
score: 78
updated: 2026-08-22
ingested:
  - source
  - agents/compiler-foundations.md
---

# compiler-completion — Review

The target-neutral algebra of how a statement finishes: normally, or by `return`, `break`, `continue`, `throw` — and with what value. ~1,070 lines across seven primitives, 51 tests. It is the floor under every control-flow decision the backends and the task package make.

## Verdict

**solid — 78/100.** This is the most rigorously specified of the new packages. Completion sets compose sequentially and alternatively with stated laws, `catch` interception and `finally` restoration/replacement are modelled rather than approximated, and the value-path algebra keeps ECMAScript's empty completion distinct from `undefined` — a distinction most hand-rolled compilers get wrong and never notice. It is not near-mature because nothing yet _produces_ completion paths from IR at scale: the algebra is complete, its supply is not.

## What a fully expressed completion domain looks like

- Normal and abrupt completion as data, with exact targets for labelled `break` and `continue`. Present.
- Sequential and alternative composition obeying stated algebraic laws, direct-tested rather than assumed. Present.
- `catch` that returns every intercepted throw path and value before replacing those routes. Present.
- `finally` that restores the incoming completion after normal cleanup and replaces it after abrupt cleanup, with `UpdateEmpty` semantics on an empty cleanup value. Present.
- Empty distinguished from `undefined` throughout, since `UpdateEmpty` is where naive implementations silently produce the wrong value. Present.
- Statement-value carriers with validated shape, so an expression-position statement sequence has one meaning. Present.
- Await scheduling and resumption expressed as completions rather than as a separate concept. Present.
- An IR-to-completion-path producer covering real bodies, feeding the state machines. **Absent** as a general capability.

## Present capabilities

- **Two layers, deliberately separated.** `CompilerCompletionSet` answers _how does this finish_; `CompilerValueCompletionPathSet` answers _by which route and carrying what_. Keeping them apart is why the value algebra can be exhaustive without the control algebra becoming unreadable.
- **`finally` done properly.** Normal cleanup restores the complete incoming completion; abrupt cleanup replaces it; an empty cleanup value is updated from the completion being replaced. This is the case that silently breaks return values in hand-written lowering.
- **`catch` returns before it replaces.** Every intercepted throw path and value is available for binding initialization before the handler's completions take over, so the caught binding cannot be initialized from a route that was already discarded.
- **Ten tagged failure codes** covering malformed kinds, targets, paths, sets, statement lists, control-flow labels, binding presence and values — inspectable data rather than message matching.
- **Exact loop, switch and label ownership**, so a `continue` belongs to the construct that owns it rather than the nearest enclosing one.
- **Deterministic, locale-independent ordering and deep immutability**, with inputs unchanged.

## Gaps

- **Supply, not algebra.** `getIrStatementListCompletionSet` walks neutral statements conservatively, but the value-path producer that the async state machines need for structured bodies does not exist — which is precisely why `compiler-task` refuses every conditional. These two packages are one gap seen from two sides.
- **Conservative analysis is unlabelled.** Where the statement analysis is conservative it produces a sound over-approximation, but a caller cannot tell an exact answer from a conservative one. A backend deciding whether to emit a fallthrough guard would want to know which it got.
- **No reachability output.** The algebra can say a statement completes abruptly on every path; nothing consumes that to report unreachable code, and `compiler-task` maintains its own `unreachable-statement` refusal rather than asking here.
- **Labels are exact but unexercised downstream.** Targeted completion sets model labelled `break`/`continue` fully, while both backends still refuse labelled targets. The model is ahead of its consumers, which is the right order and worth revisiting before the vocabulary freezes.
