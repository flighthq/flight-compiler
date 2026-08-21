---
package: '@flighthq/compiler-semantic'
status: early
score: 50
updated: 2026-08-21
ingested:
  - source
  - agents/compiler-migration-roadmap.md
  - golden/
---

# compiler-semantic — Review

TypeScript-to-neutral lowering: ~3,000 lines across the lowering pass, static-fact derivation and the barrel. It is the widest domain in the repository — the whole of TypeScript is its input — and the package that most determines how much of the Flight SDK can actually be ported.

## Verdict

**early — 50/100.** What exists is built the right way: the TypeScript compiler API rather than pattern matching, binding provenance resolved through a checker, closed operator vocabularies, and structured diagnostics for everything it will not lower. The score is low because the domain is enormous and the covered fraction is small — the roadmap says 20–25% and the refusal list bears that out. Namespaces, overloads, parameter properties, generators, decorators and most of the type system are all unrepresented; destructuring, which was on that list, is now in. That is the honest state of a slice deliberately built narrow-and-correct rather than wide-and-approximate, and the refusals are the asset here, not the embarrassment.

## What a fully expressed TypeScript-lowering domain looks like

- **Total syntactic coverage** of the language subset the SDK actually uses, with everything else refused by name rather than mis-lowered.
- **Type-directed lowering.** Many decisions — what `+` means, whether `x` is nullable, whether a call is a method or a free function — need the checker, not the syntax tree. A reference version resolves operand domains from types and lowers accordingly.
- **Complete binding provenance**: every identifier resolved to a declaration with a stable id, scope and kind, so a target can rename freely without breaking references. Largely present.
- **Semantic facts alongside syntax**: truthiness, numeric domain, mutability, aliasing, receiver identity, purity — the things a target needs to choose a representation. Present in first form.
- **Narrowing and control-flow facts.** TypeScript's narrowing is load-bearing in idiomatic code; a lowerer that ignores it produces code whose declared types and actual values disagree.
- **Diagnostics that locate and explain**: file, line, column, the construct, and what would have to exist to support it. Present.
- **Overload and declaration-merging resolution** into a single lowered form.
- **Deterministic, caller-non-mutating operation over a shared program.** Present.
- **A coverage report**: which upstream declarations lowered, which refused, and by which rule — so a port can measure its own readiness.

## Present capabilities

- **Compiler-API parsing throughout.** No regular-expression syntax inference anywhere; every decision reads the parsed tree, and `.tsx` is parsed as TSX.
- **Binding provenance through a checker.** Module declarations, local exports including type-only aliases, imports, parameters, locals, loop and catch bindings, named function expressions, closures and class `this` all resolve to stable ids with kind and scope. The lowerer parses its own tree for this so caller-owned ASTs are never mutated — verified by a caller-immutability test.
- **Stable ids survive renaming.** Both backends map binding ids to current spellings, so a semantic rename keeps internal references aligned rather than dangling. This is what makes the patch system safe to use on real code.
- **Closed operator vocabularies with exhaustive token maps.** Adding an IR operator or dropping a TypeScript token mapping is a compile error, verified by planting drift in both directions. Before this, unmapped operators passed through verbatim into both target languages.
- **Static facts as their own primitive.** `compilerIrStaticFacts.ts` derives receiver identity, typed-array classification, mixed-width writes, truthiness and logical domains rather than leaving each backend to infer them.
- **Enum values resolved, not copied.** Auto-increment follows TypeScript's rule (a member after `A = 1` is 2, not its index), string and numeric members are separated, and a member after a string value without an initializer is refused. The naive index-based version was a real defect that produced colliding discriminants.
- **Export syntax represented.** `IrModule.exports` carries re-export, export-all, namespace and default records, so a barrel is data rather than a silently skipped statement — an earlier version dropped them with no diagnostic at all.
- **Structured refusal, uniformly.** Around thirty named diagnostics, each locating the construct and naming what is missing. The contract that unsupported syntax is never approximated is honoured.

## Gaps

Measured against the reference, in rough order of how much SDK surface each blocks:

- **Destructuring is represented; the remaining hole is catch.** Variable and parameter binding patterns now lower to `IrBindingPattern` — nested, defaulted, rest and tuple-typed — and the neutral pass library normalizes them for both targets. A destructured catch binding still refuses. This gap moved from "blocks any real codebase" to "one construct", and it is the clearest single example of what porting a construct vertically looks like here.
- **Function and method overloads.** Declaration overloads are collected but class method overloads and constructor overloads refuse outright. Overload sets are how the SDK expresses optional-argument APIs.
- **Parameter properties.** `constructor(private readonly x: number)` refuses. It is the common TypeScript class idiom.
- **Namespaces and `export =`.** Unrepresented in the IR at all.
- **Most of the type system.** Conditional, mapped, template-literal, `infer`, variadic tuples and recursive aliases have no IR representation, so nothing can lower them.
- **The refusals name passes that have no home.** Sixty-two of the seventy-seven backend refusals point at a lowering — control flow, async, nullability, call-site, structural copy — and none of those transformations exists anywhere. Most are neutral work this package's output should be transformable into rather than work either emitter should invent; see [the breadth analysis](../../compiler-breadth.md).
- **No narrowing model.** The nullability refusal in both backends exists precisely because narrowing is unmodelled: after `if (value === undefined) return fallback;`, the lowerer cannot tell the backends that `value` is now non-optional, so the honest move was to refuse. Every nullable-parameter function in the SDK is blocked behind this.
- **No async or generator lowering.** Both are refused by both backends; the neutral model has no task or coroutine concept to lower them into.
- **No decorators, no class static blocks, no accessors.** Getters and setters refuse as unsupported class members.
- **Type-directed operator semantics are named but incomplete.** The roadmap's next iterations — declared-versus-flow operand domains, populated from checker evidence, then numeric arithmetic and narrowed storage — are the missing half of what makes `+` lowerable.
- **No coverage report.** There is no way to point the lowerer at the SDK and ask what fraction of its declarations lower today. The counters that once purported to do this were removed for being ambiguous, correctly, but nothing replaced them — and this is the number the migration most needs.
- **Single-file lowering only.** Each source lowers independently; cross-module semantic facts (is this exported type used as a value anywhere, is this function ever awaited) are not available to the lowerer.

## Re-score, 2026-08-21 — 38 to 44, and why only six points

Nine iterations landed here after the original review. The reported measure was unreached arms falling from 331 to 185, and that is the weaker of the two numbers available: this repository's own testing conventions say an arm missing from the untested list was _taken_ by some test, not necessarily _checked_ by one. So I read the assertions instead of the count.

They hold up. `maps every atomic and literal TypeScript type to its neutral domain` enumerates the whole atomic and literal domain and asserts the complete mapping with an exact `toEqual` over a full list, and its siblings pair each domain with the neighbors it must reject — enum constant algebra with invalid neighbors, export topologies with rejected statements, named and operator type identity with unsupported families isolated. That is example-driven specification with counterexamples, which is what the bar here asks for, not coverage decoration.

The score moves only six points because of what the diff actually contains: **`typeScriptSemanticLowering.ts` grew by 26 lines and lost 8, while its tests grew by 572 and the static-fact tests by 146.** Roughly ninety-six percent of the batch is verification of surface that already existed. Two genuine capabilities did arrive — block/function/declaration binding scope classification, and shorthand object values resolving to their lexical bindings rather than their property symbols, which is a real defect fixed rather than a test added.

That distinction is the point. This score measures how much of the domain is _expressed_, and the domain did not grow by ninety-six percent of a batch; its existing slice became far better specified, which is part of maturity but not the same axis. Destructuring, namespaces, generators, decorators and most of the type system remain unrepresented, and porting them is what moves this number materially. A score that jumped on test count would be making exactly the mistake the arm count invites.

## Closed since the re-score

- **Labeled `break` and `continue` no longer lose their label.** The neutral IR carries `IrControlFlowLabelIdentity`; a labeled statement lowers to a labeled block or labeled loop, `break`/`continue` carry a resolved `target`, and a label that cannot be resolved refuses by name. The earlier unconditional label drop — and the unrelated unsupported-statement guard that was the only thing hiding it — are both gone. Rust emits real labels; Haxe refuses them explicitly pending completion-state lowering.

## Amendment, same day — 44 to 50

The re-score above listed destructuring among the unrepresented constructs. That was already wrong when written: variable and parameter binding patterns lower to `IrBindingPattern` with nested, defaulted, rest and tuple-typed forms, and only a destructured catch binding still refuses. Destructuring is the single most common of the constructs this package was missing, so crediting it moves the score six points on its own — this is domain expressed, not tests added, which is the axis the re-score argued for.

The correction matters more than the six points. A review that reads a diff for what it _verifies_ can miss what it _adds_; the destructuring work arrived spread across ten commits titled for lowering and tuples rather than one titled for destructuring, and the summary judgement inherited the old shape of the gap list instead of re-reading the refusals. Re-derive the refusal list from source on every re-score.
