# flight-hx adoption register

Status: the compiler publishes the Haxe integration contracts and the latest reported compiler-owned emission fixes; a fresh full downstream build is still required.

This register separates Haxe source-generation failures owned by `flight-compiler` from runtime, host-binding, and public-package assembly owned by `flight-hx`. The measured input is the full Flight SDK closure at Flight revision `65889a191bb0d2f5f2f95148590874f3e49bf9d4`, using flight-hx integration revision `0d8dd838b03601dc3bb6e771bd3f1edfbcb37e7d`. The extern graph has 154 packages and 2,855 source modules; the transpile graph has 2,866 modules.

## 2026-09-14 compiler follow-up

Flight-hx reported that its run at compiler revision `993c28080d1b3f6e55214ae2d92215d51cd192ff` reached 2,855/2,855 extern modules with zero refusals or corrections and verified all 7,077 reported exports, including 6,204 functions and 873 values. Its remaining failures were compiler-owned: 32 referenced public aliases had no extern file, type/value collision suffixes diverged across facade imports, Unicode identifiers remained unescaped, nullish property assignment produced an invalid block receiver, and contract type re-exports were absent.

Compiler revision `8952dbd3` addresses those five classes. Public extern aliases now emit as nominal files from the authoritative package facade, non-public aliases remain structurally inlined, Unicode identifiers use deterministic code-point escapes, nullish assignment uses a value-returning closure and evaluates property receivers once, and contract facades emit/import their type aliases through one collision-aware allocation. Facade aliases include the facade module name because Haxe 4.3.7 treats secondary type names as package-global; redeclaring a source alias under the same simple name in `Contract.hx` is itself invalid Haxe.

Focused verification passed: ten transpiler regressions, all forty extern-emission tests, the backend package typecheck, and a Haxe 4.3.7 compile-and-run probe covering a contract type/value collision plus nullish property assignment. This is not yet the adoption exit: the flight-hx agent's newest 2,682-file candidate was uncommitted and is not present in this isolated workspace, whose available flight-hx checkouts predate that candidate. Flight-hx must regenerate the full trees at `8952dbd3` or later and report the next fail-loud Haxe callback result.

## Current compiler output

The 2026-09-13 transpile run at compiler revision `0a16cb5b29d961039292fc0c01f3dd1f1ecd0ea0` emitted all 2,866 modules and 2,866 compiler files across 154 packages, with zero direct or propagated refusals. The generated tree is dependency-closed. The final compiler commits after that pin add only regression coverage and the expanded runtime ABI manifest; they do not change emitted module contents.

The extern run at compiler revision `8087b5a6d4e0ba78e74b3aacc8aa67bc947c6667` emitted 2,853 of the 2,855 modules supplied by flight-hx. Its sole root is not a compiler lowering or emission refusal: flight-hx excludes every `*TestHelper.ts` input in extern mode, while the public render-wgpu contract imports and re-exports `./wgpuTestHelper`. The missing input refuses `contract.ts`, which in turn refuses `index.ts`. Including the public source is required to reach 2,855/2,855.

The current compiler publishes three integration contracts in `flight-compiler-package-report/1`:

- `exports` is the compiler-resolved public type/value facade plan, including barrels and re-export routes;
- `typescript` pins TypeScript 5.9.3 and the package-graph checker configuration as compiler identity; and
- `runtimeAbi` is the versioned Haxe runtime manifest, including target spellings for external symbols, constructors, task operations, ambient members, and backend intrinsics. `flight-haxe-runtime-abi/2` explicitly publishes `_ArrayTools.pushMany`, the complete `_Js` semantic-helper surface, and the serial `_AsyncIterable.forEachAsync` operation used to lower `for await`.

The package graph is checked as one TypeScript project with the pinned bundled standard library. Library declarations supply semantic evidence but remain external ABI identities, and built-in utility aliases stay on their explicit neutral lowering paths instead of being expanded into TypeScript implementation shapes.

The current extern batch assigns exact representations to all 15 direct roots from the baseline. `AppearanceFlags`, `LogLevel`, `RenderRegistry`, and `TextureAtlasRotation` emit as exact numeric or string Haxe enum abstracts, including merged enum namespace functions. The external types `GPULoadOp`, `GPUPrimitiveTopology`, `GPUAdapter`, `AsyncIterable`, `ImageBitmap`, `PointerEvent`, `AudioNode`, `WebGLShader`, `HTMLDivElement`, and `HTMLVideoElement` have explicit native or runtime bindings. `ImageBitmap` accounts for two root modules.

The compiler also absorbs the correction classes proven by focused flight-hx output: nested callback return parentheses, stable string-union enum member identifiers, generic defaults, callable-constraint erasure, Promise-void carriers, unique-symbol phantom fields, optional calls, assignment grouping, variadic `Math.min`/`Math.max`, runtime `Math` members, multi-value `Array.push`, callable `Symbol` construction, receiver-instantiated optional collection results, and serial async iteration.

## flight-hx blockers

The updated flight-hx integration still has three compiler-report adoption gaps:

- `createNormalizedHaxeBackend` copies `name`, `emitModule`, and `createEmissionSession`, but drops the backend's `runtimeAbi` function. The wrapper must forward that function for `compilation.report.runtimeAbi` to reach its manifest or adoption gate.
- The extern driver still discovers contract value exports with a regular-expression walker and filters holder members downstream. It must consume `compilation.report.exports` as the authoritative type/value/function surface.
- The extern input scanner explicitly excludes `*TestHelper.ts`, even when the compiler-resolved public export graph requires the source. This currently causes the render-wgpu `wgpuTestHelper` root and its one-module cascade.
- The generated manifest always declares 24 common compatibility corrections and five extern-only corrections, even when a correction no longer changes compiler output. The driver must remove absorbed transformations and report only corrections actually applied before the correction ledger can reach zero. One stale transform is actively harmful on current output: replacing `Math.log2`, `Math.sign`, and `Math.trunc` after the compiler has already emitted the configured runtime path changes `flight._internal._Math.*` into `flight._internal._flight._internal._Math.*` in 17 generated files.

The maintained runtime under `src/flight/_internal` currently implements 16 of the 50 top-level runtime targets published by `flight-haxe-runtime-abi/2`. The exact missing snapshot is `_Array`, `_ArrayBuffer`, `_AsyncIterable`, `_DataView`, `_Int8Array`, `_Intl`, `_IntlCollator`, `_IntlCollatorOptions`, `_IntlDateTimeFormat`, `_IntlDateTimeFormatOptions`, `_IntlListFormat`, `_IntlListFormatOptions`, `_IntlNumberFormat`, `_IntlNumberFormatOptions`, `_IntlPluralRule`, `_IntlPluralRules`, `_IntlPluralRulesOptions`, `_IntlRelativeTimeFormat`, `_IntlRelativeTimeFormatOptions`, `_IntlRelativeTimeFormatUnit`, `_IntlSegmenter`, `_IntlSegmenterOptions`, `_Js`, `_Json`, `_Number`, `_Object`, `_Proxy`, `_RegExp`, `_RegExpExecArray`, `_Symbol`, `_TextDecoder`, `_TypedArray`, `_Url`, and `_WeakSet`. The work queue must continue to be derived from `report.runtimeAbi`; this list is only the pin-specific audit snapshot.

The Haxe 4.3.7 complete-tree callback reaches compilation and currently stops at `generated/hx/flight/_hx/types/VoxelGrid.hx:10` with `Type not found : flight._internal._ArrayBuffer`. No stub was introduced to bypass it, so later compiler-versus-runtime errors remain deliberately unhidden. Haxe also still needs an explicit target contract for distinct TypeScript `null` and `undefined`; strict comparisons and optional-plus-null parameters must continue to refuse until that ABI is exact.

## Reproduction

From the updated local flight-hx checkout with its dependency lock pointed at the compiler revision under test:

```sh
npm run generate -- --extern
npm run generate -- --transpile
node tools/haxe.mjs -cp generated/js -cp generated -D flight_esm -js /tmp/flight-haxe-extern.js --macro "include('flight._js')"
node tools/haxe.mjs -cp generated/hx -cp src -D flight_hx --no-output --macro "include('flight._hx')"
```

The transpile generator already invokes the pinned Haxe 4.3.7 complete-source callback. It must remain fail-loud: no stubs, silent omissions, or approximate semantics.

## Adoption exit

Adoption is complete at 2,855/2,855 extern modules and 2,866/2,866 transpiled modules, with dependency-closed output, zero direct or propagated refusals, zero internal-error records, and zero downstream compatibility corrections. The complete emitted trees must compile through the Haxe 4.3.7 callback and pass behavioral parity.
