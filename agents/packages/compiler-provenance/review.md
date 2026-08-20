---
package: '@flighthq/compiler-provenance'
status: near-mature
score: 82
updated: 2026-08-20
ingested:
  - source
  - agents/compiler-foundations.md
---

# compiler-provenance — Review

The narrowest package in the repository: 130 lines across one implementation source and its colocated test, three exported functions, no internal compiler dependency. It answers one question — are two pieces of source the same thing? — and everything above it that claims stable identity rests on that answer.

## Verdict

**near-mature — 82/100.** The domain is genuinely small and this package has most of it. Normalization is structural rather than textual, the schema is declared in the hashed string, and the equivalence/counterexample pairs the maturity standard asks for are all present and pinned. What holds it below the nineties is one decision — the TypeScript version inside the hash — that trades a rare correctness hazard for a guaranteed mass invalidation, and the absence of any identity beyond a single node.

## What a fully expressed source-identity domain looks like

A reference implementation of this domain would provide:

- **A declared, versioned normalization scheme.** The bytes that are hashed are a format, so they carry a schema tag and change only deliberately.
- **Identity that survives irrelevant difference and separates relevant difference.** Formatting, comments, quote style, line endings and source path do not change identity; a different program never shares one. Both directions are tested with explicit pairs.
- **Identity at every granularity the callers need** — a node, a declaration, a file, a module, and a whole checkout — with a defined composition rule between them, so a file fingerprint is derivable from its declarations rather than separately invented.
- **Toolchain independence.** The identity of a piece of source does not change because the parser was upgraded. A parser upgrade may change _how_ identity is computed, and that is a scheme version bump with a stated migration, not an accident of a patch release.
- **A content-addressed store or manifest** so a fingerprint can be resolved back to what it names, making a stale patch report _what_ it expected rather than only that expectations differ.
- **Collision economics stated.** Which hash, why, what a collision would mean, and what the package does if two distinct programs ever produce one.
- **Cheap incremental identity.** Re-fingerprinting an unchanged file is O(1) against a cache keyed by file mtime/size, not a re-walk of its tree.

## Present capabilities

- **Structural normalization.** `normalizeTypeScriptNode` walks the parsed tree and emits `kind:len:text` leaves and `kind[...]` branches, with JSDoc children filtered. Because it is structural, comments, whitespace and quote spelling fall out for free while _semantic_ whitespace does not.
- **A declared schema.** The hashed string is prefixed `flight-typescript-node/1;…`, so the format is nameable and versionable rather than implicit.
- **Real counterexamples, pinned.** The test asserts that `"a b"` and `"a  b"` differ, and the same for `/a b/` versus `/a  b/`. This is not decoration: the previous printer-based normalization collapsed all whitespace and merged those pairs, which meant two different programs shared a fingerprint and a stale patch could apply silently to changed code. That defect was found by mutation-adjacent review and closed here.
- **Equivalence pinned in the same file.** Compact versus formatted source with comments, CRLF versus LF, single versus double quotes, and differing source paths all produce one identity.
- **Explicit hash identity.** `fingerprintSourceText` returns a `sha256:`-prefixed digest, and an exact expected digest for a known input is asserted, so the algorithm cannot change silently.
- **No compiler dependency.** It sits on the dependency floor with only `typescript`, which is what lets everything above it depend on identity without a cycle.

## Gaps

- **The TypeScript version is inside the hash, and it does not need to be.** `normalizeTypeScriptNode` embeds `typescript=${ts.version}`, so a routine `5.9.3 → 5.9.4` bump invalidates every fingerprint in the repository at once and makes every semantic patch stale although no upstream source changed. That conflates "upstream edited" with "our toolchain moved", which is the opposite of what the staleness gate is for. The root cause is `String(node.kind)`: numeric `SyntaxKind` values are not stable across TypeScript releases, so the version tag is defending against a real hazard. Serializing `ts.SyntaxKind[node.kind]` — the name, which _is_ stable — removes the hazard at its source and lets the version tag leave the hash or become metadata beside it. The schema tag still provides deliberate invalidation. This is cheapest to change now, while no patches exist downstream.
- **One granularity only.** There is a node fingerprint and nothing else. A file, module, package or checkout identity is either re-derived by each caller or absent; `compiler-inventory` computes its own record fingerprints and `gitCheckoutRevision` answers checkout identity separately. A reference version would define the composition rule once here.
- **No reverse lookup.** A fingerprint names something but cannot produce it. A stale patch can therefore say "expected `sha256:ab…`, received `sha256:cd…`" and nothing more; with a content-addressed manifest it could show what it expected.
- **No collision statement.** SHA-256 is the obvious choice and the risk is negligible, but the package does not say so, and "obvious" is what a foundational contract is supposed to write down.
- **No incremental path.** Every fingerprint is computed from a full subtree walk on every run. Nothing caches by file identity, so a large checkout re-walks everything each time. Not yet a problem at current scale, and worth naming before it is.
- **Unicode normalization is untested at this seam.** Emitted paths get NFC canonicalization in `compiler-emission`; source text identity does not state whether two canonically-equivalent identifiers are the same declaration. The answer is probably "TypeScript already decided", but the package should say which.
