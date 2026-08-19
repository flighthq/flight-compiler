# Testing Conventions

What a test must prove, how to run the narrowest one that answers your question, and the named shapes in which a green run proves nothing. The structural rules are enforced by `npm run exports:check`; everything below it is review's job.

## Structure

- One test file per source file, colocated in the package's `src/`, named `<concept>.test.ts`. `exports:check` requires the exact name and one `describe('<function>')` block per exported function.
- Keep `describe` blocks in source/API order, not alphabetical order, so a reader can follow the file and its test side by side.
- `compiler-types` is exempt: it is type-only, so `tsc` is its contract gate. Add a compile-time composition test there only when it proves an assignability, inference, or exhaustiveness property a reader would otherwise have to infer.
- `scripts/` is repository automation and carries focused tests only where the risk warrants them. Script tests import `describe`, `expect` and `it` from `vitest` explicitly, because the scripts build does not load the Vitest globals.
- Tests use temporary fixture workspaces and never depend on a network checkout.

## The two lanes

`npm run check` runs the unit tests twice, deliberately.

- `test:packages` runs each workspace alone. This proves package boundaries: an undeclared dependency or a leaked import fails here and nowhere else.
- `test:coverage` runs everything together with instrumentation, and measures the repository against its ratchets.

Neither lane subsumes the other. While iterating, prefer the narrowest meaningful run — one test file, then one workspace — and broaden only once the local change is understood. Broad runs are confidence gates; focused runs are the editing loop.

**A selector that runs nothing is unconfigured, not clean.** A green zero-work pass is the same defect as a gate with no evidence: it reports success for work it never did.

## What a bedrock test proves

Tests are example-driven specifications, not coverage decoration. For a foundational function, cover:

- positive behavior, and equivalence between inputs the contract says are the same;
- **counterexamples** — near neighbors the contract says are different. Normalization may erase irrelevant spelling differences but must never merge distinct programs, so every normalizer needs both directions;
- empty, boundary, and malformed values;
- deterministic ordering, and independence from host path separators and line endings;
- caller-input immutability where the contract promises it;
- every tagged failure code, by its code rather than by message text.

A green test run is not a compile guarantee: `npm run test` does not typecheck. Attestation requires `npm run check`.

## Verifying a guard that lands with its fix

**A guard committed alongside the behavior it protects must be seen failing against the old behavior.** Once both land there is no revision containing the new guard and the old subject, so a green run proves only that the two coexist — not that the guard discriminates.

Before committing, run one revert-and-restore cycle:

1. Restore the old behavior without weakening the new guard.
2. Run the narrow command that exercises the guard.
3. Require it to go red **by the guard's own name**, showing the actual wrong values. "Something failed" is not evidence that this guard noticed.
4. Restore the fix, confirm the diff contains the intended behavior, and require green.

Never commit the temporary old behavior. The same rule applies to a health gate: plant the violation it exists to catch, watch it name the violation, then restore.

The negative twin: **a probe reporting no defect is only trustworthy once you know it ran.** An argument-shape mistake can turn a real probe into a silent no-op, which looks exactly like "nothing wrong". Assert that the subject did something observable rather than that it did not throw.

## Assertions that cannot fail

Named shapes where the test and the code are each fine and the test still proves nothing. All are invisible on a green run.

- **The tautology.** The expected value is computed by the same expression the subject uses, so the assertion restates the implementation. It survives any change to that expression.
- **The unreachable branch.** The fixture never constructs the case the assertion describes, so the interesting line never executes. Coverage catches some of these; a fixture built from the same misunderstanding as the code catches none.
- **The absent referent.** The assertion compares against a value that no longer exists — an empty collection, an undefined lookup — and passes because both sides are empty.
- **The swallowed failure.** The subject is wrapped so a throw becomes a pass, usually a bare `expect(() => …).not.toThrow()` standing in for a behavioral claim.
- **The shared fixture.** The fixture encodes the same belief as the code, so both are wrong together. This one survives mutation testing too, because mutation changes code and cannot invent the missing input.

## Choosing an instrument

Coverage percentage does not establish maturity. A one-line primitive can be fully covered and still have a weak contract; a type-only contract has no runtime statements and still needs design scrutiny.

Pick the instrument from the plausible shape of wrongness:

- **Branch and sibling logic** — compare siblings against each other. Divergence between two implementations that should agree is a defect one of them is hiding.
- **Unconsidered input domains** — non-finite values, overflow, representable limits, empty and malformed input. Mutation testing cannot find these, because it changes code rather than inventing input.
- **Emitters** — assert the emitted text, then assert the failure when the construct is not lowerable. Both directions matter: this compiler's correctness claim is as much about what it refuses as what it produces.

Apply an instrument where its failure model is plausible, rather than applying every instrument everywhere.

`npm run mutation -- <package>` substitutes one operator at a time and reruns that file's colocated test. The mutated text is served from memory and never written to disk, so the working tree is untouched even if the run is interrupted, and a substitution that would not change the source throws rather than reporting a survivor from an edit that never happened.

`npm run untested -- <package>` is its complement: it lists the arms no test ever took, where mutation asks whether the arms that were taken are actually checked. An arm missing from the untested list was taken by some test, not necessarily checked by one, so an empty list means nobody has looked here rather than that the package is verified.

Neither is part of `npm run check`: one mutant costs a whole Vitest start, so the instrument is minutes where the gates are seconds. A surviving mutant is a question. Some survivors are equivalent mutants no test could distinguish; others mark an assertion that cannot fail. Read the line before concluding either.

## Coverage ratchets

The thresholds in `vitest.config.ts` are enforced floors that sit just below the measured baseline, so a regression fails immediately. Maintain or raise them as exercised surface grows; lowering one requires an explicit architectural justification recorded with the change.

A floor set far under the measurement is not a ratchet, and a floor set exactly at it fails on unrelated work. Raise the floors as part of the change that raises coverage, not as a separate sweep.

## What belongs in a unit test

- Behavior belongs in the colocated test of the package that owns it, where the developer changing that code will see it.
- There is no standing "integration" or "API" bucket. The public facade is already exercised by `packages:check`, `pack:check`, and the facade's own test; a barrel smoke test is a weaker version of work the gate already does.
- Cross-cutting output fidelity — the same fixture compiled to Haxe and Rust, byte for byte — belongs to the golden-output parity harness described in [the migration roadmap](../compiler-migration-roadmap.md), not to a package unit test.
- Proving that emitted Haxe or Rust actually compiles is a downstream concern for `flight-hx` and `flight-rs`, fed by fixtures from here. This repository does not install those toolchains.
