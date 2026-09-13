import type {
  CompilerRuntimeCapabilityName,
  CompilerRuntimeExternalMemberBinding,
  CompilerRuntimeExternalSymbolBinding,
  CompilerRuntimeExternalSymbolBindingPlan,
  CompilerRuntimeExternalSymbolSpace,
  IrInterfaceDeclaration,
  IrModule,
  IrType,
} from '../../compiler-types/src/index.js';

type HaxeRuntimeExternalSymbolBinding =
  | Readonly<{
      kind: Extract<CompilerRuntimeExternalSymbolBinding, { kind: 'native' }>['kind'];
      members?: readonly CompilerRuntimeExternalMemberBinding[] | undefined;
      runtimeMembers?: readonly CompilerRuntimeExternalMemberBinding[] | undefined;
      sourceName: string;
      space: CompilerRuntimeExternalSymbolSpace;
      targetName: string;
    }>
  | Readonly<{
      capability: CompilerRuntimeCapabilityName;
      kind: Extract<CompilerRuntimeExternalSymbolBinding, { kind: 'runtime' }>['kind'];
      members?: readonly CompilerRuntimeExternalMemberBinding[] | undefined;
      sourceName: string;
      space: CompilerRuntimeExternalSymbolSpace;
      targetName: string;
    }>;

export function createCompilerRuntimeExternalSymbolBindingPlanHaxe(): CompilerRuntimeExternalSymbolBindingPlan {
  return {
    bindings: haxeRuntimeExternalSymbolBindings.map((binding) =>
      binding.kind === 'runtime'
        ? {
            capability: binding.capability,
            externalSymbol: { sourceName: binding.sourceName, space: binding.space },
            kind: binding.kind,
          }
        : {
            externalSymbol: { sourceName: binding.sourceName, space: binding.space },
            kind: binding.kind,
          },
    ),
    contract: 'flight-runtime-contract/2',
  };
}

export function getCompilerAmbientUtilityHeritageTargetHaxe(
  declaration: Readonly<IrInterfaceDeclaration>,
  module?: Readonly<IrModule> | undefined,
): string | undefined {
  if (declaration.extends.length !== 1) return undefined;
  const heritage = declaration.extends[0]!;
  if (
    heritage.reference.kind !== 'ambient' ||
    heritage.reference.name !== 'Pick' ||
    heritage.typeArguments.length !== 2
  ) {
    return undefined;
  }
  const keys = getIrAmbientPickHeritageKeysHaxe(heritage.typeArguments[1]!, module, new Set());
  const materialized = new Set(declaration.properties.map((property) => property.name));
  if (!keys || [...keys].some((key) => !materialized.has(key))) return undefined;
  const target = heritage.typeArguments[0]!;
  if (target.kind !== 'named' || target.reference.kind !== 'ambient') return undefined;
  return getCompilerRuntimeExternalSymbolTargetHaxe(target.reference.name, 'type');
}

// Namespace-like ambient values have no Haxe value of their own. Their members decide the complete
// target expression, so `Number.isFinite` can become `Math.isFinite` without making bare `Number`
// look like a valid Haxe constructor.
export function getCompilerRuntimeExternalMemberTargetHaxe(
  sourceName: string,
  member: string,
  runtimeModule = 'flighthq._internal',
): string | undefined {
  const normalized = sourceName.normalize('NFC');
  const binding: HaxeRuntimeExternalSymbolBinding | undefined = haxeRuntimeExternalSymbolBindings.find(
    (candidate) => candidate.sourceName === normalized && candidate.space === 'value',
  );
  if (!binding) return undefined;
  const normalizedMember = member.normalize('NFC');
  const target = binding.members?.find((candidate) => candidate.sourceMember === normalizedMember)?.targetName;
  if (target) return binding.kind === 'runtime' ? `${runtimeModule}.${target}` : target;
  const runtimeTarget =
    binding.kind === 'native'
      ? binding.runtimeMembers?.find((candidate) => candidate.sourceMember === normalizedMember)?.targetName
      : undefined;
  return runtimeTarget ? `${runtimeModule}.${runtimeTarget}` : undefined;
}

export function getCompilerRuntimeExternalSymbolTargetHaxe(
  sourceName: string,
  space: CompilerRuntimeExternalSymbolSpace,
  runtimeModule = 'flighthq._internal',
): string | undefined {
  const normalized = sourceName.normalize('NFC');
  const binding = haxeRuntimeExternalSymbolBindings.find(
    (candidate) => candidate.sourceName === normalized && candidate.space === space,
  );
  if (!binding) return undefined;
  return binding.kind === 'runtime' ? `${runtimeModule}.${binding.targetName}` : binding.targetName;
}

function getIrAmbientPickHeritageKeysHaxe(
  type: Readonly<IrType>,
  module: Readonly<IrModule> | undefined,
  aliases: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
  if (type.kind === 'never') return new Set();
  if (type.kind === 'literal' && typeof type.value === 'string') return new Set([type.value]);
  if (type.kind === 'union') {
    const members = type.types.map((member) => getIrAmbientPickHeritageKeysHaxe(member, module, aliases));
    return members.some((member) => !member) ? undefined : new Set(members.flatMap((member) => [...member!]));
  }
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.path.length > 0 ||
    type.typeArguments.length > 0 ||
    !module
  ) {
    return undefined;
  }
  const bindingId = type.reference.binding.id;
  const alias = module.declarations.find(
    (declaration) =>
      declaration.kind === 'typeAlias' &&
      declaration.binding.id === bindingId &&
      declaration.typeParameters.length === 0,
  );
  if (alias?.kind !== 'typeAlias' || aliases.has(alias.binding.id)) return undefined;
  return getIrAmbientPickHeritageKeysHaxe(alias.type, module, new Set(aliases).add(alias.binding.id));
}

const haxeIntlRuntimeTypeTargets = [
  ['Intl.Collator', '_IntlCollator'],
  ['Intl.CollatorOptions', '_IntlCollatorOptions'],
  ['Intl.DateTimeFormat', '_IntlDateTimeFormat'],
  ['Intl.DateTimeFormatOptions', '_IntlDateTimeFormatOptions'],
  ['Intl.LDMLPluralRule', '_IntlPluralRule'],
  ['Intl.ListFormat', '_IntlListFormat'],
  ['Intl.ListFormatOptions', '_IntlListFormatOptions'],
  ['Intl.NumberFormat', '_IntlNumberFormat'],
  ['Intl.NumberFormatOptions', '_IntlNumberFormatOptions'],
  ['Intl.PluralRules', '_IntlPluralRules'],
  ['Intl.PluralRulesOptions', '_IntlPluralRulesOptions'],
  ['Intl.RelativeTimeFormat', '_IntlRelativeTimeFormat'],
  ['Intl.RelativeTimeFormatOptions', '_IntlRelativeTimeFormatOptions'],
  ['Intl.RelativeTimeFormatUnit', '_IntlRelativeTimeFormatUnit'],
  ['Intl.Segmenter', '_IntlSegmenter'],
  ['Intl.SegmenterOptions', '_IntlSegmenterOptions'],
] as const;

const haxeRuntimeExternalSymbolBindings = [
  { kind: 'native', sourceName: 'AbortController', space: 'type', targetName: 'js.html.AbortController' },
  { kind: 'native', sourceName: 'AbortSignal', space: 'type', targetName: 'js.html.AbortSignal' },
  { kind: 'native', sourceName: 'Array', space: 'type', targetName: 'Array' },
  {
    capability: 'array',
    kind: 'runtime',
    members: [{ sourceMember: 'isArray', targetName: '_Array.isArray' }],
    sourceName: 'Array',
    space: 'value',
    targetName: '_Array',
  },
  {
    capability: 'array-buffer',
    kind: 'runtime',
    sourceName: 'ArrayBuffer',
    space: 'type',
    targetName: '_ArrayBuffer',
  },
  {
    capability: 'array-buffer',
    kind: 'runtime',
    sourceName: 'ArrayBuffer',
    space: 'value',
    targetName: '_ArrayBuffer',
  },
  { kind: 'native', sourceName: 'ArrayBufferLike', space: 'type', targetName: 'haxe.io.Bytes' },
  { kind: 'native', sourceName: 'ArrayBufferView', space: 'type', targetName: 'haxe.io.ArrayBufferView' },
  { kind: 'native', sourceName: 'ArrayLike', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'AudioBuffer', space: 'type', targetName: 'js.html.audio.AudioBuffer' },
  { kind: 'native', sourceName: 'AudioContext', space: 'type', targetName: 'js.html.audio.AudioContext' },
  { kind: 'native', sourceName: 'Blob', space: 'type', targetName: 'js.html.Blob' },
  { kind: 'native', sourceName: 'Boolean', space: 'type', targetName: 'Bool' },
  { kind: 'native', sourceName: 'CanvasFillRule', space: 'type', targetName: 'js.html.CanvasWindingRule' },
  { kind: 'native', sourceName: 'CanvasGradient', space: 'type', targetName: 'js.html.CanvasGradient' },
  { kind: 'native', sourceName: 'CanvasImageSource', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'CanvasPattern', space: 'type', targetName: 'js.html.CanvasPattern' },
  {
    kind: 'native',
    sourceName: 'CanvasRenderingContext2D',
    space: 'type',
    targetName: 'js.html.CanvasRenderingContext2D',
  },
  { kind: 'native', sourceName: 'CanvasRenderingContext2DSettings', space: 'type', targetName: 'Dynamic' },
  { capability: 'data-view', kind: 'runtime', sourceName: 'DataView', space: 'type', targetName: '_DataView' },
  { capability: 'data-view', kind: 'runtime', sourceName: 'DataView', space: 'value', targetName: '_DataView' },
  { capability: 'date', kind: 'runtime', sourceName: 'Date', space: 'type', targetName: '_Date' },
  { capability: 'date', kind: 'runtime', sourceName: 'Date', space: 'value', targetName: '_Date' },
  { kind: 'native', sourceName: 'Error', space: 'type', targetName: 'haxe.Exception' },
  { kind: 'native', sourceName: 'Error', space: 'value', targetName: 'haxe.Exception' },
  {
    kind: 'native',
    sourceName: 'EXT_texture_filter_anisotropic',
    space: 'type',
    targetName: 'js.html.webgl.extension.EXTTextureFilterAnisotropic',
  },
  {
    capability: 'float32-array',
    kind: 'runtime',
    sourceName: 'Float32Array',
    space: 'type',
    targetName: '_Float32Array',
  },
  { kind: 'native', sourceName: 'FontFace', space: 'type', targetName: 'js.html.FontFace' },
  { kind: 'native', sourceName: 'GlobalCompositeOperation', space: 'type', targetName: 'js.html.CompositeOperation' },
  { kind: 'native', sourceName: 'GPUBindGroup', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'GPUBindGroupLayout', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'GPUBuffer', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'GPUCanvasContext', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'GPUCommandEncoder', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'GPUDevice', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'GPUDeviceLostInfo', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'GPUIndexFormat', space: 'type', targetName: 'String' },
  { kind: 'native', sourceName: 'GPUPipelineLayout', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'GPUPowerPreference', space: 'type', targetName: 'String' },
  { kind: 'native', sourceName: 'GPURenderPassEncoder', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'GPURenderPipeline', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'GPUSampler', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'GPUShaderModule', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'GPUTexture', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'GPUTextureFormat', space: 'type', targetName: 'String' },
  { kind: 'native', sourceName: 'GPUTextureView', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'GPUVertexBufferLayout', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'HTMLCanvasElement', space: 'type', targetName: 'js.html.CanvasElement' },
  { kind: 'native', sourceName: 'HTMLElement', space: 'type', targetName: 'js.html.Element' },
  { kind: 'native', sourceName: 'ImageSmoothingQuality', space: 'type', targetName: 'String' },
  {
    capability: 'float32-array',
    kind: 'runtime',
    sourceName: 'Float32Array',
    space: 'value',
    targetName: '_Float32Array',
  },
  {
    capability: 'float64-array',
    kind: 'runtime',
    sourceName: 'Float64Array',
    space: 'type',
    targetName: '_Float64Array',
  },
  {
    capability: 'float64-array',
    kind: 'runtime',
    sourceName: 'Float64Array',
    space: 'value',
    targetName: '_Float64Array',
  },
  {
    capability: 'int16-array',
    kind: 'runtime',
    sourceName: 'Int16Array',
    space: 'type',
    targetName: '_Int16Array',
  },
  {
    capability: 'int16-array',
    kind: 'runtime',
    sourceName: 'Int16Array',
    space: 'value',
    targetName: '_Int16Array',
  },
  {
    capability: 'int32-array',
    kind: 'runtime',
    sourceName: 'Int32Array',
    space: 'type',
    targetName: '_Int32Array',
  },
  {
    capability: 'int32-array',
    kind: 'runtime',
    sourceName: 'Int32Array',
    space: 'value',
    targetName: '_Int32Array',
  },
  {
    capability: 'int8-array',
    kind: 'runtime',
    sourceName: 'Int8Array',
    space: 'type',
    targetName: '_Int8Array',
  },
  {
    capability: 'int8-array',
    kind: 'runtime',
    sourceName: 'Int8Array',
    space: 'value',
    targetName: '_Int8Array',
  },
  {
    capability: 'internationalization',
    kind: 'runtime',
    members: [
      { sourceMember: 'Collator', targetName: '_IntlCollator' },
      { sourceMember: 'DateTimeFormat', targetName: '_IntlDateTimeFormat' },
      { sourceMember: 'ListFormat', targetName: '_IntlListFormat' },
      { sourceMember: 'NumberFormat', targetName: '_IntlNumberFormat' },
      { sourceMember: 'PluralRules', targetName: '_IntlPluralRules' },
      { sourceMember: 'RelativeTimeFormat', targetName: '_IntlRelativeTimeFormat' },
      { sourceMember: 'Segmenter', targetName: '_IntlSegmenter' },
    ],
    sourceName: 'Intl',
    space: 'value',
    targetName: '_Intl',
  },
  ...haxeIntlRuntimeTypeTargets.map(([sourceName, targetName]) => ({
    capability: 'internationalization' as const,
    kind: 'runtime' as const,
    sourceName,
    space: 'type' as const,
    targetName,
  })),
  { capability: 'map', kind: 'runtime', sourceName: 'Map', space: 'type', targetName: '_Map' },
  { capability: 'map', kind: 'runtime', sourceName: 'Map', space: 'value', targetName: '_Map' },
  { kind: 'native', sourceName: 'Infinity', space: 'value', targetName: 'Math.POSITIVE_INFINITY' },
  { kind: 'native', sourceName: 'Math', space: 'value', targetName: 'Math' },
  { kind: 'native', sourceName: 'NaN', space: 'value', targetName: 'Math.NaN' },
  {
    kind: 'native',
    members: [
      { sourceMember: 'EPSILON', targetName: '2.220446049250313e-16' },
      { sourceMember: 'MAX_SAFE_INTEGER', targetName: '9.007199254740991e15' },
      { sourceMember: 'MAX_VALUE', targetName: '1.7976931348623157e308' },
      { sourceMember: 'MIN_SAFE_INTEGER', targetName: '-9.007199254740991e15' },
      { sourceMember: 'MIN_VALUE', targetName: '4.9406564584124654e-324' },
      { sourceMember: 'NEGATIVE_INFINITY', targetName: 'Math.NEGATIVE_INFINITY' },
      { sourceMember: 'POSITIVE_INFINITY', targetName: 'Math.POSITIVE_INFINITY' },
      { sourceMember: 'isFinite', targetName: 'Math.isFinite' },
      {
        sourceMember: 'isInteger',
        targetName:
          '(function(numberValue:Float) return Math.isFinite(numberValue) && Math.ffloor(numberValue) == numberValue)',
      },
      { sourceMember: 'isNaN', targetName: 'Math.isNaN' },
      {
        sourceMember: 'isSafeInteger',
        targetName:
          '(function(numberValue:Float) return Math.isFinite(numberValue) && Math.ffloor(numberValue) == numberValue && Math.abs(numberValue) <= 9.007199254740991e15)',
      },
      { sourceMember: 'parseFloat', targetName: 'Std.parseFloat' },
    ],
    runtimeMembers: [{ sourceMember: 'parseInt', targetName: '_Number.parseInt' }],
    sourceName: 'Number',
    space: 'value',
    targetName: 'Number',
  },
  {
    capability: 'object',
    kind: 'runtime',
    members: [
      { sourceMember: 'assign', targetName: '_Object.assign' },
      { sourceMember: 'entries', targetName: '_Object.entries' },
      { sourceMember: 'is', targetName: '_Object.is' },
      { sourceMember: 'keys', targetName: '_Object.keys' },
    ],
    sourceName: 'Object',
    space: 'value',
    targetName: '_Object',
  },
  { capability: 'task', kind: 'runtime', sourceName: 'Promise', space: 'type', targetName: '_Promise' },
  { capability: 'task', kind: 'runtime', sourceName: 'Promise', space: 'value', targetName: '_Promise' },
  { kind: 'native', sourceName: 'ReadableStream', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'RangeError', space: 'type', targetName: 'haxe.Exception' },
  { kind: 'native', sourceName: 'RangeError', space: 'value', targetName: 'haxe.Exception' },
  { kind: 'native', sourceName: 'Record', space: 'type', targetName: 'haxe.DynamicAccess' },
  { capability: 'regexp', kind: 'runtime', sourceName: 'RegExp', space: 'type', targetName: '_RegExp' },
  { capability: 'regexp', kind: 'runtime', sourceName: 'RegExp', space: 'value', targetName: '_RegExp' },
  {
    capability: 'regexp',
    kind: 'runtime',
    sourceName: 'RegExpExecArray',
    space: 'type',
    targetName: '_RegExpExecArray',
  },
  { capability: 'map', kind: 'runtime', sourceName: 'ReadonlyMap', space: 'type', targetName: '_Map' },
  { capability: 'set', kind: 'runtime', sourceName: 'ReadonlySet', space: 'type', targetName: '_Set' },
  { capability: 'set', kind: 'runtime', sourceName: 'Set', space: 'type', targetName: '_Set' },
  { capability: 'set', kind: 'runtime', sourceName: 'Set', space: 'value', targetName: '_Set' },
  { kind: 'native', sourceName: 'String', space: 'type', targetName: 'String' },
  { kind: 'native', sourceName: 'String', space: 'value', targetName: 'String' },
  {
    capability: 'symbol',
    kind: 'runtime',
    members: [{ sourceMember: 'for', targetName: '_Symbol.forKey' }],
    sourceName: 'Symbol',
    space: 'value',
    targetName: '_Symbol',
  },
  {
    capability: 'text-decoder',
    kind: 'runtime',
    sourceName: 'TextDecoder',
    space: 'type',
    targetName: '_TextDecoder',
  },
  {
    capability: 'text-decoder',
    kind: 'runtime',
    sourceName: 'TextDecoder',
    space: 'value',
    targetName: '_TextDecoder',
  },
  { kind: 'native', sourceName: 'TypeError', space: 'type', targetName: 'haxe.Exception' },
  { kind: 'native', sourceName: 'TypeError', space: 'value', targetName: 'haxe.Exception' },
  {
    capability: 'uint16-array',
    kind: 'runtime',
    sourceName: 'Uint16Array',
    space: 'type',
    targetName: '_UInt16Array',
  },
  {
    capability: 'uint16-array',
    kind: 'runtime',
    sourceName: 'Uint16Array',
    space: 'value',
    targetName: '_UInt16Array',
  },
  {
    capability: 'uint32-array',
    kind: 'runtime',
    sourceName: 'Uint32Array',
    space: 'type',
    targetName: '_UInt32Array',
  },
  {
    capability: 'uint32-array',
    kind: 'runtime',
    sourceName: 'Uint32Array',
    space: 'value',
    targetName: '_UInt32Array',
  },
  {
    capability: 'uint8-array',
    kind: 'runtime',
    sourceName: 'Uint8Array',
    space: 'type',
    targetName: '_UInt8Array',
  },
  {
    capability: 'uint8-array',
    kind: 'runtime',
    sourceName: 'Uint8Array',
    space: 'value',
    targetName: '_UInt8Array',
  },
  {
    capability: 'uint8-clamped-array',
    kind: 'runtime',
    sourceName: 'Uint8ClampedArray',
    space: 'type',
    targetName: '_UInt8ClampedArray',
  },
  { capability: 'url', kind: 'runtime', sourceName: 'URL', space: 'type', targetName: '_Url' },
  { capability: 'url', kind: 'runtime', sourceName: 'URL', space: 'value', targetName: '_Url' },
  {
    capability: 'uint8-clamped-array',
    kind: 'runtime',
    sourceName: 'Uint8ClampedArray',
    space: 'value',
    targetName: '_UInt8ClampedArray',
  },
  { capability: 'weak-map', kind: 'runtime', sourceName: 'WeakMap', space: 'type', targetName: '_WeakMap' },
  { capability: 'weak-map', kind: 'runtime', sourceName: 'WeakMap', space: 'value', targetName: '_WeakMap' },
  { kind: 'native', sourceName: 'WeakSet', space: 'type', targetName: 'Dynamic' },
  { kind: 'native', sourceName: 'WebGLBuffer', space: 'type', targetName: 'js.html.webgl.Buffer' },
  {
    kind: 'native',
    sourceName: 'WebGLContextAttributes',
    space: 'type',
    targetName: 'js.html.webgl.ContextAttributes',
  },
  { kind: 'native', sourceName: 'WebGLFramebuffer', space: 'type', targetName: 'js.html.webgl.Framebuffer' },
  { kind: 'native', sourceName: 'WebGLPowerPreference', space: 'type', targetName: 'js.html.webgl.PowerPreference' },
  { kind: 'native', sourceName: 'WebGLProgram', space: 'type', targetName: 'js.html.webgl.Program' },
  { kind: 'native', sourceName: 'WebGLRenderbuffer', space: 'type', targetName: 'js.html.webgl.Renderbuffer' },
  { kind: 'native', sourceName: 'WebGLTexture', space: 'type', targetName: 'js.html.webgl.Texture' },
  {
    kind: 'native',
    sourceName: 'WebGLUniformLocation',
    space: 'type',
    targetName: 'js.html.webgl.UniformLocation',
  },
  {
    kind: 'native',
    sourceName: 'WebGL2RenderingContext',
    space: 'type',
    targetName: 'js.html.webgl.WebGL2RenderingContext',
  },
  {
    kind: 'native',
    sourceName: 'WebGLVertexArrayObject',
    space: 'type',
    targetName: 'js.html.webgl.VertexArrayObject',
  },
  { kind: 'native', sourceName: 'WritableStream', space: 'type', targetName: 'Dynamic' },
  { capability: 'json', kind: 'runtime', sourceName: 'JSON', space: 'value', targetName: '_Json' },
  {
    capability: 'number-parsing',
    kind: 'runtime',
    sourceName: 'parseInt',
    space: 'value',
    targetName: '_Number.parseInt',
  },
  { kind: 'native', sourceName: 'parseFloat', space: 'value', targetName: 'Std.parseFloat' },
  { kind: 'native', sourceName: 'isFinite', space: 'value', targetName: 'Math.isFinite' },
  { kind: 'native', sourceName: 'isNaN', space: 'value', targetName: 'Math.isNaN' },
] as const satisfies readonly HaxeRuntimeExternalSymbolBinding[];
