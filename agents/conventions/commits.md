# Commit Conventions

Every commit is one Conventional Commit subject line with no body and no trailers. The subject is the whole message: a reader scanning `git log --oneline` sees the complete claim, and a reviewer reading a parcel sees one change per commit.

## Format

```text
type(scope): subject
```

- **type** — what kind of change, from the closed set below.
- **scope** — optional, and where the change lands: a workspace slug without its `compiler-` prefix (`patch`, `semantic`, `backend-hx`), or an area bucket (`scripts`, `docs`, `deps`). A repository-wide change takes no scope.
- **`!` before the colon** flags a breaking change: `refactor(types)!: …`.

Scopes are open rather than enumerated, so a new workspace or area needs no configuration change. When present they are lower case, matching workspace identity.

## Types

A language, target, or location word is never a type — it is a scope.

| type       | use                                           |
| ---------- | --------------------------------------------- |
| `feat`     | new compiler capability or contract           |
| `fix`      | corrected behavior                            |
| `docs`     | documentation only                            |
| `refactor` | behavior-preserving restructuring             |
| `test`     | tests only                                    |
| `perf`     | performance without behavior change           |
| `build`    | build system, gates, or repository automation |
| `ci`       | continuous integration configuration          |
| `style`    | formatting only                               |
| `chore`    | housekeeping that fits nothing above          |
| `revert`   | reverting an earlier commit                   |

## Subject

- Imperative mood, lower case after the colon, no trailing period.
- Name the change, not the file: `fix: reject switch fallthrough before Haxe emission` rather than `fix: update backend`.
- One coherent change per commit. A refactor and the behavior change it enables are two commits, so that either can be read or reverted alone.

## No body, no trailers

The repository deliberately carries no commit bodies, `Co-Authored-By` trailers, or issue references. Durable reasoning belongs where a reader will find it later: a comment at the invariant it protects, an `agents/` document for a decision with scope, or the test that pins the behavior. A body is read once, by whoever is already reviewing that commit.

## Enforcement

`commitlint` runs from the `commit-msg` hook and checks the type set, scope case, and subject shape. It cannot check whether the subject is honest — that stays with review.

The `pre-commit` hook runs `lint-staged`, which lints and formats only the staged files. The `pre-push` hook runs the short `npm run check:push` profile. Use `npm run check` for the full static sweep and reserve `npm run verify` for CI, releases, or an explicitly requested broad gate. Keep hooks fast enough that nobody is tempted to bypass them.
