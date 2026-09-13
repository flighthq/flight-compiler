# flight-hx adoption register

Status: the compiler publishes the Haxe integration contracts; full downstream adoption is not yet buildable.

This register separates Haxe source-generation failures owned by `flight-compiler` from runtime, host-binding, and public-package assembly owned by `flight-hx`. The measured input is the full Flight SDK closure at Flight revision `65889a191bb0d2f5f2f95148590874f3e49bf9d4`, using flight-hx integration revision `0d8dd838b03601dc3bb6e771bd3f1edfbcb37e7d`. The extern graph has 154 packages and 2,855 source modules; the transpile graph has 2,866 modules.

## Current compiler output

The last completed extern baseline, at compiler revision `de46714a749b7add8a1667b0603a75e175480871`, emitted 2,025 Haxe files from 1,630 modules and refused 1,225 modules. Only 15 refusals were direct; the rest were dependency propagation. The earlier transpile measurement emitted 2,233 modules and refused 633, including 153 direct refusals; it predates the current Haxe compiler batch and is retained only as a comparison point.

The current compiler publishes three integration contracts in `flight-compiler-package-report/1`:

- `exports` is the compiler-resolved public type/value facade plan, including barrels and re-export routes;
- `typescript` pins TypeScript 5.9.3 and the package-graph checker configuration as compiler identity; and
- `runtimeAbi` is the versioned Haxe runtime manifest, including target spellings for external symbols, constructors, task operations, and ambient members.

The package graph is checked as one TypeScript project with the pinned bundled standard library. Library declarations supply semantic evidence but remain external ABI identities, and built-in utility aliases stay on their explicit neutral lowering paths instead of being expanded into TypeScript implementation shapes.

The current extern batch assigns exact representations to all 15 direct roots from the baseline. `AppearanceFlags`, `LogLevel`, `RenderRegistry`, and `TextureAtlasRotation` emit as exact numeric or string Haxe enum abstracts, including merged enum namespace functions. The external types `GPULoadOp`, `GPUPrimitiveTopology`, `GPUAdapter`, `AsyncIterable`, `ImageBitmap`, `PointerEvent`, `AudioNode`, `WebGLShader`, `HTMLDivElement`, and `HTMLVideoElement` have explicit native or runtime bindings. `ImageBitmap` accounts for two root modules.

The compiler also absorbs the correction classes proven by focused flight-hx output: nested callback return parentheses, stable string-union enum member identifiers, generic defaults, callable-constraint erasure, Promise-void carriers, unique-symbol phantom fields, optional calls, assignment grouping, variadic `Math.min`/`Math.max`, runtime `Math` members, multi-value `Array.push`, and callable `Symbol` construction.

## flight-hx blockers

The updated flight-hx integration still has three compiler-report adoption gaps:

- `createNormalizedHaxeBackend` copies `name`, `emitModule`, and `createEmissionSession`, but drops the backend's `runtimeAbi` function. The wrapper must forward that function for `compilation.report.runtimeAbi` to reach its manifest or adoption gate.
- The extern driver still discovers contract value exports with a regular-expression walker and filters holder members downstream. It must consume `compilation.report.exports` as the authoritative type/value/function surface.
- The generated manifest always declares 24 common compatibility corrections and five extern-only corrections, even when a correction no longer changes compiler output. The driver must remove absorbed transformations and report only corrections actually applied before the correction ledger can reach zero.

The maintained runtime under `src/flight/_internal` currently implements arrays, dates, maps, math, promises, sets, strings, typed arrays, and weak maps. Comparing its module files with the compiler manifest leaves 33 top-level targets unimplemented, including `_AsyncIterable`, `_ArrayBuffer`, `_DataView`, `_Intl`, `_Object`, `_Proxy`, `_RegExp`, `_Symbol`, `_TextDecoder`, `_Url`, and `_WeakSet`. The complete work queue should be derived from `report.runtimeAbi` rather than maintained by hand. Haxe also still needs an explicit target contract for distinct TypeScript `null` and `undefined`; strict comparisons and optional-plus-null parameters must continue to refuse until that ABI is exact.

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
