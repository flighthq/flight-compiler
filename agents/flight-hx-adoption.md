# flight-hx adoption register

Status: compiler emission is progressing; downstream adoption is not yet buildable.

This register separates Haxe source-generation failures owned by `flight-compiler` from the runtime, host-binding, and public-package assembly owned by `flight-hx`. The measured input is the full Flight SDK closure at Flight revision `65889a191bb0d312c28c0dc1cb06e253f52587c6` (154 packages and 2,866 source modules).

## Current compiler output

The latest full transpile emitted 2,233 Haxe modules and refused 633. Of those refusals, 153 are direct; the rest are dependency propagation. The latest full extern pass emitted 2,025 files from 1,635 modules and refused 1,231 modules, with only 15 direct roots.

This compiler batch removed the last observed compiler-owned roots from the focused Flight package closures:

- mutable re-exports now retain JavaScript live-binding behavior through read-only Haxe getters;
- per-export package-resolution edges select the correct barrel route without retaining unrelated imports in the reduced facade plan;
- private interfaces may erase a direct ambient base only under an explicit backend policy and only when Haxe has a target binding for that base;
- nullish comparison evidence consults the declared aliased type as well as the flow-lowered type, so a `null` member hidden by a local alias is not mistaken for an undefined-only value.

The real spritesheet closure now emits its contract and index facade. A fresh full-source run improved from 2,229 emitted modules and 156 direct refusals to 2,233 and 153 respectively. No direct refusal in that run names an unimplemented neutral language construct, facade route, interface-inheritance path, or lost nullable-return proof.

## flight-hx blockers

The locally pinned Haxe 4.3.7 toolchain is healthy: `npm run proof` passes. Compiling the compiler outputs stops at downstream seams:

- Transpiled source fails first because `flight._hx._runtime._WeakMap` does not exist. The generated tree depends on the versioned runtime surface under `flight._hx._runtime`; `flight-hx` currently contains only the proof-of-shape `_hx` implementation and no production runtime package.
- Extern output initially fails because the new hidden `flight._js.*` typedefs have no matching regenerated public `flight.*` selector modules. Supplying temporary selectors advances compilation to the next downstream seam, the absent `flighthq._internal._Promise` runtime type. The extern tree references 22 runtime types: ArrayBuffer, DataView, Date, Map, Set, WeakMap, Promise, seven typed-array variants, and eight Intl option/unit types.
- `flight-hx` must replace or adapt its skunkworks public-facade generator so that the checked-in `flight.*` surface selects the compiler-emitted `_js` externs and `_hx` source modules. This is project assembly across independently generated backends, not TypeScript semantic lowering.
- Haxe needs a target contract for distinct TypeScript `null` and `undefined`. Until that ABI exists, strict comparisons and optional-plus-null parameters remain explicit refusals rather than being silently collapsed.
- The source runtime/host profile still needs browser, media, timing, encoding, WebGL, and WebGPU bindings, Intl two-argument constructors, `String.localeCompare`, and `Array.flat`.

The extern pass has 15 direct roots. Ten distinct host types account for eleven of them because `ImageBitmap` occurs in two contracts: `GPULoadOp`, `GPUPrimitiveTopology`, `AsyncIterable`, `ImageBitmap`, `PointerEvent`, `AudioNode`, `WebGLShader`, `HTMLImageElement`, `HTMLDivElement`, and `HTMLVideoElement`. The remaining four roots require an agreed extern representation for source enums: `AppearanceFlags`, `LogLevel`, `RenderRegistry`, and `TextureAtlasRotation`.

## Reproduction

From the local `flight-hx` checkout, with the generated roots on the Haxe classpath:

```sh
node tools/haxe.mjs -cp <transpile-output> -cp src -D flight_hx --no-output --macro "include('flight._hx')"
node tools/haxe.mjs -cp <extern-output> -cp generated -D flight_esm -js /tmp/flight-haxe-extern.js --macro "include('flight._js')"
```

The first command reports `Type not found : flight._hx._runtime._WeakMap`. The second reports the first missing public selector (`flight.TauriDialogMessageOptions`); after adding temporary selectors for emitted extern typedefs, it reports `Type not found : flighthq._internal._Promise`.

## Adoption exit

Adoption is complete when `flight-hx` provides the runtime and host-binding profile above, regenerates the public selector/facade layer from compiler output, and its Haxe compiler callback accepts the complete emitted file set for both the ESM extern and transpiled-source modes. The current output is therefore useful and substantially broader, but it is not yet a full buildable Flight API.
