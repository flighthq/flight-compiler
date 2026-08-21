# Compiler Naming Contract

This contract makes compiler source and API identity independent of directory context. It applies to authored TypeScript in package `src/` directories and every declaration exported from a compiler implementation file. Repository automation under `scripts/` is explicitly outside this package contract; see [the codebase map](../AGENTS.md#workspace-layout).

## Source Files

A file is named for the stable concept it owns, not for one operation implemented inside it. Names use lower camel case and contain no command verb. Related operations live together under their concept: `compilerSemanticPatch.ts` owns applying, defining, and identifying semantic patches; `sourceFingerprint.ts` owns source normalization and fingerprint operations.

Non-routine package TypeScript basenames are unique across `packages/`, compared case-insensitively. Colocated tests inherit the concept and append `.test.ts`, so `sourceFingerprint.test.ts` remains self-identifying. Repeated package `index.ts` files are the single package-entry exception.

Generic containers such as `shared.ts`, `internal.ts`, `utils.ts`, and `helpers.ts` are not domains. When code does not fit a precise concept name, its boundary is not settled enough to add.

## Exported APIs

Every exported declaration name has one definition home across the project. Export barrels re-export those identities; they do not create competing definitions.

Exported runtime APIs are named free function declarations. Their grammar is:

```text
<verb><FullType><Modifier?>
```

The verb states the operation. The type segment names the complete compiler type or domain concept being operated on. A modifier is added only when it distinguishes a variant, result, or target. This yields names such as `getPackageInventoryRootExportLane`, `applySemanticPatchSet`, and `convertSourcePathToHaxeModuleName`. Boolean functions begin with `is` or `has`, accessors with `get`, and allocation with `create`.

Types and interfaces remain globally unique concept nouns in `compiler-types`; the verb grammar applies only to runtime APIs. Package slugs use the approved `hx` and `rs` tokens, while source symbols spell `Haxe` and `Rust` in full. For target-neutral IR inputs, the target is the modifier: `emitIrModuleHaxe` and `emitIrModuleRust`. A target-specific backend is itself the allocated type identity: `createHaxeCompilerBackend` and `createRustCompilerBackend`.

## Reserved Words

Three environments meet in this compiler and the words for them are not interchangeable. [AGENTS.md](../AGENTS.md) defines the distinction; the naming consequence is:

- **Runtime** names the ambient surface generated code may assume. Use it for capability names, binding plans, and external-symbol identity.
- **Host** names the environment that embeds and runs the generated program — Capacitor, Electron, Node, Playwright, Tauri. Use it for endpoint inventories, package host facts, and opaque host values.
- **Machine** names the computer the compiler runs on. Use it for determinism and portability concerns: separators, locale, filesystem order, absolute paths.

Never spell the third sense "host". `createFileSystemWorkspaceSource` is named for what it reads, not for the computer it reads on, and its sibling is `createMemoryWorkspaceSource` — filesystem versus memory is the real distinction. The TypeScript compiler API spells the machine sense `ts.CompilerHost`; that vocabulary belongs to the API this compiler consumes, not to the names authored here.

## Enforcement

`npm run packages:check` rejects duplicate non-routine TypeScript basenames, verb-shaped or generic source names, duplicate exported declarations, exported runtime constants, and exported functions outside the approved verb-first grammar. Outside the type-only `compiler-types` workspace, `npm run exports:check` requires a matching concept test file and an exact `describe('<function>')` block for every exported function. The latter is a structural naming gate, not proof that an assertion exercises the function. The AST helpers and naming predicates have focused unit coverage in `scripts/packageHealthAst.test.ts`.

The gate proves structural form, not vocabulary quality. Review still decides whether a type segment is complete, whether a modifier carries real meaning, and whether a proposed concept deserves its own file.
