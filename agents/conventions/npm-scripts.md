# npm Script Naming

Read this before adding, renaming, or removing a root `package.json` script. It encodes decisions that are easy to violate and not obvious from reading one script line. The grammar is Flight's; this document states how it applies to the compiler repository.

## Grammar

Scripts are colon-delimited, most-general segment first:

```text
action : subject : modifier…
```

- **action** — the verb: what you do. `build`, `test`, `check`, `format`, `lint`, `clean`, `pack`.
- **subject** — what it acts on, immediately after the action: a lane (`packages`, `exports`, `docs`), an artifact (`dist`), or a measured thing. The subject is the parity axis: `test:packages` and `test:coverage` are the same action over different subjects.
- **modifier(s)** — narrow the action: a mode (`check`, `fix`, `watch`), or a variant.

**Never let a non-subject word take the subject slot.** When a distinction needs a new word, make it a modifier after the subject or a different action — never a second subject.

## `:check` is a mode, not a subject

`:check` is the **non-writing mode of an existing verb**. `format` writes; `format:check` reports and fails. `lint` reports; `lint:fix` writes. A name ending in `:check` is a claim that the bare verb exists or would exist and does the corresponding work.

Where this repository's gate has no writing counterpart, the bare name is deliberately absent rather than a stub: `packages:check`, `exports:check`, `docs:check`, `order:check`, and `pack:check` inspect structure that nothing rewrites for you today. Adding an inert `packages` alias would suggest a fix mode that does not exist.

`order:check` is the clearest candidate for a future writer: its rules are mechanical, so a bare `order` that rewrites import blocks and moves exported functions is a coherent command to add. It is absent because rewriting source is a riskier capability than reporting on it, not because the name is unavailable.

When a gate later gains an automatic fix, it takes the bare name (or `:fix`) and the `:check` name keeps meaning exactly what it means now. Do not invert that pairing by making the bare name the failing one.

## Collapsing (aliases)

Omitting a segment yields a collapse alias that fans over the omitted axis. Aliases only chain leaf scripts — the real command lives in the leaf and is never duplicated into the alias.

- **Omit the subject** → run that action across every subject. `check` is the whole-repository sweep over every registered gate.
- **Omit the modifier** → the umbrella for that subject.

Every meaningful collapse should exist, so the obvious thing to type works.

## The check sweep

`check` is the fully collapsed quality alias and the only command a contributor must remember before handoff. It is not an `&&` chain: `scripts/repositoryCheck.ts` registers every gate and runs all of them, because these gates are independent and stopping at the first failure hides the rest. A gate whose inputs depend on an earlier step guards its own inputs instead — `pack:check` builds before it inspects the tarball, so it can never report health for a stale `dist/`.

Registering the same gate label twice throws rather than running it twice, because a doubled stage is invisible in a green sweep. See [`scripts/checkGateRegistry.ts`](../../scripts/checkGateRegistry.ts).

`ci` is `clean` plus `check`: the same sweep from a cold tree.

## Read versus write

A command that compares against a committed baseline reads under its bare name and writes under an explicit write mode. This repository has no baselines yet; when one lands, the write mode is `:baseline` and it attaches to the check that owns that baseline. Only a check that owns a baseline gets one.

**One subject, one instrument.** Two commands that measure the same thing by different mechanisms make it impossible to say which gate exists. If a second measurement is genuinely needed, it names a different subject.

## Word choice

- Use the word a reader reaches for unprompted; if a name needs explaining, find a more precise one.
- Avoid words that misdescribe the mechanism. `exports:check` proves test structure and naming, not assertion depth, and the command's own output says so.
- Name the question, not the implementation.

## Documentation is part of the contract

Every `npm run <name>` citation in tracked Markdown must name a real script; `docs:check` fails on one that does not, and prints how many citations it resolved so a zero is readable as measured rather than as never executed. A workspace-scoped citation (`--workspace`, `--prefix`) resolves against that workspace's manifest and is reported separately, as is a metasyntactic placeholder such as `npm run X`.

A citation written as a bare backticked script name with no `npm run` lead is real rot the gate cannot see, because a bare token cannot be separated from prose without a dictionary that would also match ordinary English. Write the lead.

## Current surface

| script                    | meaning                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| `check`                   | the whole-repository sweep; every gate runs and failures are reported together |
| `ci`                      | `clean` then `check`                                                           |
| `fix`                     | apply lint fixes and formatting                                                |
| `format` / `format:check` | write formatting / fail on unformatted files                                   |
| `lint` / `lint:fix`       | report lint findings / write fixes                                             |
| `typecheck`               | strict no-emit check for the root and every workspace                          |
| `packages:check`          | manifests, layout, dependency direction, naming, and facade completeness       |
| `exports:check`           | one colocated test per source and one `describe()` per exported function       |
| `docs:check`              | bounded codebase map, Claude pointer, local links, and command citations       |
| `order:check`             | import grouping and alphabetization, and exported-function order in packages   |
| `test` / `test:watch`     | run the aggregate suite once / in watch mode                                   |
| `test:packages`           | run every workspace in isolation, proving package boundaries                   |
| `test:coverage`           | run the aggregate suite with instrumentation against the coverage ratchets     |
| `build`                   | clean stale output and assemble the public artifact                            |
| `pack:check`              | build fresh, then inspect the publishable tarball                              |
| `clean` / `clean:dist`    | remove generated output / remove distribution output only                      |
| `mutation`                | report surviving mutants for one package; a worklist, not a gate               |
