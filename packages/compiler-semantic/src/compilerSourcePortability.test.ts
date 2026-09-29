import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { TypeScriptPackageGraphSource } from '../../compiler-types/src/index.js';
import { analyzeTypeScriptSourcePortability } from './compilerSourcePortability.js';

describe('analyzeTypeScriptSourcePortability', () => {
  it('reports stable actionable sites for the three Flight source gate concepts', () => {
    const source = input(
      'contract.ts',
      [
        'type NativeHandle = unknown;',
        'interface Contract {',
        '  payload: unknown;',
        '  error: unknown;',
        '  records: Readonly<Record<string, any>>;',
        '  maybe?: string | null;',
        '  required: string | null | undefined;',
        '  convert(value: any): unknown;',
        '}',
        'declare const source: string;',
        'const first = source as unknown as number;',
        'const second = <boolean><any>source;',
        'const third = source as never as symbol;',
        'const fourth = (source as unknown) as bigint;',
      ].join('\n'),
    );

    const report = analyzeTypeScriptSourcePortability([source]);

    expect(report.schema).toBe('flight-compiler-source-portability/1');
    expect(report.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'mixed-absence', subject: 'interface:Contract/property:maybe' },
      { rule: 'mixed-absence', subject: 'interface:Contract/property:required' },
      { rule: 'opaque-value-domain', subject: 'interface:Contract/method:convert.parameter:value' },
      { rule: 'opaque-value-domain', subject: 'interface:Contract/method:convert.return' },
      { rule: 'opaque-value-domain', subject: 'interface:Contract/property:error' },
      { rule: 'opaque-value-domain', subject: 'interface:Contract/property:payload' },
      { rule: 'opaque-value-domain', subject: 'interface:Contract/property:records' },
      { rule: 'opaque-value-domain', subject: 'type:NativeHandle' },
      { rule: 'unchecked-double-assertion', subject: 'module' },
      { rule: 'unchecked-double-assertion', subject: 'module' },
      { rule: 'unchecked-double-assertion', subject: 'module' },
      { rule: 'unchecked-double-assertion', subject: 'module' },
    ]);
    expect(report.findings.every((finding) => finding.line > 0 && finding.column > 0)).toBe(true);
    expect(report.findings.every((finding) => finding.message.includes(finding.subject))).toBe(true);
    expect(report.findings.every((finding) => finding.identity.includes(finding.fingerprint))).toBe(true);
    expect(report.findings.some((finding) => finding.message.includes('through any'))).toBe(true);
    expect(report.findings.some((finding) => finding.message.includes('through unknown'))).toBe(true);
    expect(report.findings.some((finding) => finding.message.includes('through never'))).toBe(true);
    expect(report.acceptedExceptions).toEqual([]);
  });

  it('is input-order independent and keeps identities stable across trivia changes', () => {
    const compact = input('compact.ts', 'interface Value { payload: unknown }');
    const formatted = input('compact.ts', 'interface Value {\n  payload: unknown;\n}\n');
    const other = input('other.ts', 'interface Options { value?: string | null }');

    const first = analyzeTypeScriptSourcePortability([compact, other]);
    const reordered = analyzeTypeScriptSourcePortability([other, compact]);
    const reformatted = analyzeTypeScriptSourcePortability([formatted, other]);

    expect(reordered).toEqual(first);
    expect(reformatted.findings.map((finding) => finding.identity)).toEqual(
      first.findings.map((finding) => finding.identity),
    );
    expect(reformatted.findings[0]?.line).not.toBe(first.findings[0]?.line);
  });

  it('projects a fresh entity clone only after deleting its exact runtime key', () => {
    const declarations = `declare const EntityRuntimeKey: unique symbol;
       declare const ForeignRuntimeKey: unique symbol;
       interface Entity { [EntityRuntimeKey]: object | undefined }
       type EntityWithoutRuntime<Type extends Entity> = Omit<Type, typeof EntityRuntimeKey>;`;
    const asserted = input(
      'packages/entity/src/clone.ts',
      `${declarations}
       export function stripEntityRuntime<Type extends Entity>(
         source: Readonly<Type>,
       ): EntityWithoutRuntime<Type> {
         const copy = { ...source } as Record<PropertyKey, unknown>;
         delete copy[EntityRuntimeKey];
         return copy as unknown as EntityWithoutRuntime<Type>;
       }`,
    );
    const typed = input(
      'packages/entity/src/clone.ts',
      `${declarations}
       declare function omitEntityRuntime<Type extends Entity>(
         source: Readonly<Type>,
       ): EntityWithoutRuntime<Type>;
       export function stripEntityRuntime<Type extends Entity>(
         source: Readonly<Type>,
       ): EntityWithoutRuntime<Type> {
         return omitEntityRuntime(source);
       }`,
    );
    const controls = [
      input(
        'packages/entity/src/otherClone.ts',
        `${declarations}
         function stripEntityRuntime<Type extends Entity>(source: Readonly<Type>): EntityWithoutRuntime<Type> {
           const copy = { ...source } as Record<PropertyKey, unknown>;
           delete copy[EntityRuntimeKey];
           return copy as unknown as EntityWithoutRuntime<Type>;
         }`,
      ),
      input(
        'packages/other/src/clone.ts',
        `${declarations}
         function stripEntityRuntime<Type extends Entity>(source: Readonly<Type>): EntityWithoutRuntime<Type> {
           const copy = { ...source } as Record<PropertyKey, unknown>;
           delete copy[EntityRuntimeKey];
           return copy as unknown as EntityWithoutRuntime<Type>;
         }`,
      ),
      input(
        'packages/entity/src/clone.ts',
        `${declarations}
         function cloneEntity<Type extends Entity>(source: Readonly<Type>): EntityWithoutRuntime<Type> {
           const copy = { ...source } as Record<PropertyKey, unknown>;
           delete copy[EntityRuntimeKey];
           return copy as unknown as EntityWithoutRuntime<Type>;
         }`,
      ),
      input(
        'packages/entity/src/clone.ts',
        `${declarations}
         function stripEntityRuntime<Type extends Entity>(source: Readonly<Type>): EntityWithoutRuntime<Type> {
           const copy = { ...source } as Record<string, unknown>;
           delete copy[EntityRuntimeKey];
           return copy as unknown as EntityWithoutRuntime<Type>;
         }`,
      ),
      input(
        'packages/entity/src/clone.ts',
        `${declarations}
         function stripEntityRuntime<Type extends Entity>(source: Readonly<Type>): EntityWithoutRuntime<Type> {
           const copy = { ...source, extra: true } as Record<PropertyKey, unknown>;
           delete copy[EntityRuntimeKey];
           return copy as unknown as EntityWithoutRuntime<Type>;
         }`,
      ),
      input(
        'packages/entity/src/clone.ts',
        `${declarations}
         function stripEntityRuntime<Type extends Entity>(source: Readonly<Type>): EntityWithoutRuntime<Type> {
           const copy = { ...source } as Record<PropertyKey, unknown>;
           delete copy[ForeignRuntimeKey];
           return copy as unknown as EntityWithoutRuntime<Type>;
         }`,
      ),
      input(
        'packages/entity/src/clone.ts',
        `${declarations}
         function stripEntityRuntime<Type extends Entity>(source: Readonly<Type>): EntityWithoutRuntime<Type> {
           const copy = { ...source } as Record<PropertyKey, unknown>;
           delete copy[EntityRuntimeKey];
           return source as unknown as EntityWithoutRuntime<Type>;
         }`,
      ),
      input(
        'packages/entity/src/clone.ts',
        `${declarations}
         function stripEntityRuntime<Type extends Entity>(source: Readonly<Type>): EntityWithoutRuntime<Type> {
           const copy = { ...source } as Record<PropertyKey, unknown>;
           delete copy[EntityRuntimeKey];
           return copy as any as EntityWithoutRuntime<Type>;
         }`,
      ),
    ];

    const report = analyzeTypeScriptSourcePortability([asserted]);
    const finding = report.findings[0];
    if (!finding) throw new Error('Expected an entity runtime strip assertion finding');

    expect(report.findings).toMatchObject([
      {
        rule: 'unchecked-double-assertion',
        subject: 'function:stripEntityRuntime',
      },
    ]);
    expect(finding.message).toContain('fresh { ...source } clone');
    expect(finding.message).toContain('delete copy[EntityRuntimeKey]');
    expect(finding.message).toContain('EntityWithoutRuntime<Type>');
    expect(finding.message).toContain('new generic Type row owner');
    expect(finding.message).toContain('sole cell excluded');
    expect(finding.message).toContain('same copy owner with its exact representation');
    expect(finding.message).toContain('one named generic entity-runtime strip operation');
    expect(finding.message).toContain('arbitrary owner, key, or Omit assertion is not representation evidence');
    expect(finding.message).toContain('reviewed source-portability exception is not justified');
    expect(finding.message).toContain('clone the generic row once');
    expect(finding.message).toContain('will not route it through Any');
    expect(finding.message).toContain('cast or reinterpret the source owner');
    expect(finding.message).toContain('copy or materialize a second replacement');
    expect(finding.message).toContain('side storage');
    expect(analyzeTypeScriptSourcePortability([typed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message }) => !message.includes('fresh { ...source } clone'),
        ),
      ).toBe(true);
    }
  });

  it('separates fresh WebGPU mock literals from assertions that may retain an existing carrier', () => {
    const mocks = input(
      'packages/render-wgpu/src/wgpuTestHelper.ts',
      `function makeBuffer(): GPUBuffer { return {} as unknown as GPUBuffer; }
       function makeTexture(): GPUTexture { return {} as unknown as GPUTexture; }
       function makeRenderPassEncoder(): GPURenderPassEncoder {
         return {} as unknown as GPURenderPassEncoder;
       }
       function makeCommandEncoder(): GPUCommandEncoder { return {} as unknown as GPUCommandEncoder; }
       function makePipeline(): GPURenderPipeline { return {} as unknown as GPURenderPipeline; }
       function makeDevice(): GPUDevice { return {} as unknown as GPUDevice; }
       function makeAdapter(): GPUAdapter { return {} as unknown as GPUAdapter; }
       function installGpu(): GPU { return {} as unknown as GPU; }
       function makeCanvasContext(): GPUCanvasContext { return {} as unknown as GPUCanvasContext; }`,
    );
    const existing = input(
      'existingGpuCarrier.ts',
      `declare const buffer: GPUBuffer;
       export const same = buffer as unknown as GPUBuffer;`,
    );
    const findings = analyzeTypeScriptSourcePortability([mocks]).findings;
    const targetNames = [
      'GPU',
      'GPUAdapter',
      'GPUBuffer',
      'GPUCanvasContext',
      'GPUCommandEncoder',
      'GPUDevice',
      'GPURenderPassEncoder',
      'GPURenderPipeline',
      'GPUTexture',
    ];

    expect(findings).toHaveLength(9);
    for (const targetName of targetNames) {
      expect(
        findings.filter((finding) => finding.message.includes(`fresh object literal is ${targetName};`)),
      ).toHaveLength(1);
    }
    for (const finding of findings) {
      expect(finding).toMatchObject({ rule: 'unchecked-double-assertion' });
      expect(finding.message).toContain("checks neither the target's required surface nor any host identity");
      expect(finding.message).toContain('named structural fake type');
      expect(finding.message).toContain('reviewed source-portability exception for this exact boundary');
      expect(finding.message).toContain('will not reinterpret this literal, copy it, materialize');
    }
    expect(analyzeTypeScriptSourcePortability([existing]).findings).toMatchObject([
      {
        message:
          'module uses a double assertion through unknown; replace it with a checked conversion or a narrower source type.',
        rule: 'unchecked-double-assertion',
      },
    ]);
  });

  it('requires SWF bounds cells on the retained node data owner before mutation', () => {
    const asserted = input(
      'packages/swf/src/swfNode.ts',
      `interface Rectangle { height: number; width: number; x: number; y: number }
       interface Node2DData { name: string }
       interface ShapeData extends Node2DData { commands: string[] }
       interface MorphShapeData extends ShapeData { progress: number }
       interface SwfAuthoredBoundsData extends Node2DData { authoredBounds: Rectangle }
       interface SwfMorphBoundsData extends SwfAuthoredBoundsData {
         morphEndBounds: Rectangle;
         morphStartBounds: Rectangle;
       }
       interface SwfShapeNodeData extends ShapeData, SwfAuthoredBoundsData {}
       function createSwfTexturedSprite(target: { data: Node2DData }, bounds: Rectangle): void {
         (target.data as unknown as SwfAuthoredBoundsData).authoredBounds = bounds;
       }
       function createSwfEditTextTarget(node: { data: Node2DData }, bounds: Rectangle): void {
         (node.data as unknown as SwfAuthoredBoundsData).authoredBounds = bounds;
       }
       function createSwfMorphShapeTarget(shape: { data: MorphShapeData }, bounds: Rectangle): void {
         const data = shape.data as unknown as SwfMorphBoundsData;
         data.morphStartBounds = bounds;
         (shape.data as unknown as SwfAuthoredBoundsData).authoredBounds = bounds;
       }
       function applySwfMorphBounds(shape: { data: MorphShapeData }): void {
         const data = shape.data as unknown as SwfMorphBoundsData;
         data.authoredBounds = data.morphStartBounds;
       }
       function createSwfScale9ShapeNode(target: { data: ShapeData }, bounds: Rectangle): void {
         (target.data as unknown as SwfShapeNodeData).authoredBounds = bounds;
       }`,
    );
    const typed = input(
      'portableSwfNode.ts',
      `interface Rectangle { height: number; width: number; x: number; y: number }
       interface SwfMorphBoundsData {
         authoredBounds: Rectangle;
         morphEndBounds: Rectangle;
         morphStartBounds: Rectangle;
         progress: number;
       }
       function applySwfMorphBounds(data: SwfMorphBoundsData): void {
         data.authoredBounds = data.morphStartBounds;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([asserted]).findings;

    expect(findings).toHaveLength(6);
    expect(findings.filter((finding) => finding.message.includes('as SwfAuthoredBoundsData;'))).toHaveLength(3);
    expect(findings.filter((finding) => finding.message.includes('as SwfMorphBoundsData;'))).toHaveLength(2);
    expect(findings.filter((finding) => finding.message.includes('as SwfShapeNodeData;'))).toHaveLength(1);
    expect(findings.filter((finding) => finding.message.includes('retained by target.data'))).toHaveLength(2);
    expect(findings.filter((finding) => finding.message.includes('retained by node.data'))).toHaveLength(1);
    expect(findings.filter((finding) => finding.message.includes('retained by shape.data'))).toHaveLength(3);
    for (const finding of findings) {
      expect(finding).toMatchObject({ rule: 'unchecked-double-assertion' });
      expect(finding.message).toContain('already-constructed');
      expect(finding.message).toContain('does not create those cells');
      expect(finding.message).toContain('exact portable data type retained by');
      expect(finding.message).toContain('reviewed source-portability exception');
      expect(finding.message).toContain('cannot supply storage on another target');
      expect(finding.message).toContain('will not reinterpret the owner, copy or materialize replacement data');
      expect(finding.message).toContain('or add side storage');
    }
    expect(analyzeTypeScriptSourcePortability([typed]).findings).toEqual([]);
  });

  it('keeps physics3d legacy hydration on a declared serialized owner', () => {
    const asserted = input(
      'packages/physics3d/src/world.ts',
      `interface Physics3DWorld {
         version: number;
         index: { kind: string };
         jointEvents: { broke: number[] };
         solver: { constraintByContact: Map<number, number> };
       }
       interface Physics3DSolverConfig { maxCcdRotationSubsteps: number }
       interface RigidBody3D { colliders: number[] }
       interface Physics3DContact { colliderA: number; colliderB: number }
       interface SerializedPhysics3DWorld {
         index?: { kind: string };
         jointEvents?: { broke: number[] };
         solver: { constraintByPair?: Map<number, number> };
       }
       interface SerializedPhysics3DSolverConfig { maxCcdRotationSubsteps?: number }
       interface SerializedPhysics3DBody { colliders?: number[] }
       interface SerializedPhysics3DContact { colliderA?: number; colliderB?: number }
       function hydratePhysics3DWorld(
         world: Physics3DWorld,
         config: Physics3DSolverConfig,
         body: RigidBody3D,
         contact: Physics3DContact,
       ): void {
         const version = (world as unknown as { version?: unknown }).version;
         const serializedWorld = world as unknown as SerializedPhysics3DWorld;
         const serializedConfig = config as unknown as SerializedPhysics3DSolverConfig;
         (body as unknown as SerializedPhysics3DBody).colliders ??= [];
         const serializedContact = contact as unknown as SerializedPhysics3DContact;
         void version;
         void serializedWorld;
         void serializedConfig;
         void serializedContact;
       }`,
    );
    const typed = input(
      'portablePhysics3DWorld.ts',
      `interface SerializedPhysics3DWorld {
         version?: number;
         colliderA?: number;
         colliderB?: number;
       }
       export function hydratePhysics3DWorld(world: SerializedPhysics3DWorld): void {
         world.colliderA ??= 0;
         world.colliderB ??= 0;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([asserted]).findings.filter(
      (finding) => finding.rule === 'unchecked-double-assertion',
    );

    expect(findings).toHaveLength(5);
    for (const target of [
      '{ version?: unknown }',
      'SerializedPhysics3DWorld',
      'SerializedPhysics3DSolverConfig',
      'SerializedPhysics3DBody',
      'SerializedPhysics3DContact',
    ]) {
      expect(findings.filter((finding) => finding.message.includes(`legacy ${target} view`))).toHaveLength(1);
    }
    for (const finding of findings) {
      expect(finding).toMatchObject({
        rule: 'unchecked-double-assertion',
        subject: 'function:hydratePhysics3DWorld',
      });
      expect(finding.message).toContain('already-constructed');
      expect(finding.message).toContain('not representation-equivalent');
      expect(finding.message).toContain('named versioned serialized DTO at the format boundary');
      expect(finding.message).toContain('stable serialized storage owner');
      expect(finding.message).toContain("preserve the raw object's identity");
      expect(finding.message).toContain('reviewed source-portability exception');
      expect(finding.message).toContain('will preserve an already proven representation-equivalent owner');
      expect(finding.message).toContain('will not reinterpret this carrier, cast it, copy or materialize');
      expect(finding.message).toContain('or add side storage');
    }
    expect(analyzeTypeScriptSourcePortability([typed]).findings).toEqual([]);
  });

  it('keeps interactive state bindings and property access on their concrete owners', () => {
    const asserted = input(
      'packages/interaction/src/nodeInteractiveStateBinding.ts',
      `declare const EntityRuntimeKey: unique symbol;
       interface EntityRuntime { binding: object | null }
       interface NodeInteractiveStateBinding { readonly bindingBrand: true }
       interface NodeAny { readonly kind: string }
       type NodeInteractiveStateProperty = 'alpha' | 'scaleX' | 'scaleY' | 'visible' | 'x' | 'y';
       type NodeInteractiveStateTransitionValue = boolean | number;
       function createNodeInteractiveStateBinding(result: { runtime: EntityRuntime }): NodeInteractiveStateBinding {
         return { [EntityRuntimeKey]: result.runtime } as unknown as NodeInteractiveStateBinding;
       }
       function readNodeInteractiveState(
         runtime: { node: NodeAny },
         property: NodeInteractiveStateProperty,
       ): unknown {
         const target = runtime.node as unknown as Record<NodeInteractiveStateProperty, unknown>;
         return target[property];
       }
       function writeNodeInteractiveState(
         node: NodeAny,
         property: NodeInteractiveStateProperty,
         value: NodeInteractiveStateTransitionValue,
       ): void {
         const target = node as unknown as Record<
           NodeInteractiveStateProperty,
           NodeInteractiveStateTransitionValue
         >;
         target[property] = value;
       }
       function readNodeInteractiveStateOpen(
         node: NodeAny,
         property: NodeInteractiveStateProperty,
       ): unknown {
         return (node as unknown as Record<string, unknown>)[property];
       }`,
    );
    const typed = input(
      'portableNodeInteractiveStateBinding.ts',
      `interface NodeInteractiveStateBinding { readonly bindingBrand: true }
       interface InteractiveTarget {
         alpha: number;
         scaleX: number;
         scaleY: number;
         visible: boolean;
         x: number;
         y: number;
       }
       declare function createBinding(): NodeInteractiveStateBinding;
       export function create(): NodeInteractiveStateBinding { return createBinding(); }
       export function read(target: InteractiveTarget): number { return target.x; }
       export function write(target: InteractiveTarget, value: number): void { target.x = value; }`,
    );
    const findings = analyzeTypeScriptSourcePortability([asserted]).findings.filter(
      (finding) => finding.rule === 'unchecked-double-assertion',
    );

    expect(findings).toHaveLength(4);
    const binding = findings.find((finding) => finding.subject === 'function:createNodeInteractiveStateBinding');
    const closedRead = findings.find((finding) => finding.subject === 'function:readNodeInteractiveState');
    const write = findings.find((finding) => finding.subject === 'function:writeNodeInteractiveState');
    const openRead = findings.find((finding) => finding.subject === 'function:readNodeInteractiveStateOpen');
    expect(binding?.message).toContain('fresh { [EntityRuntimeKey]: result.runtime } literal');
    expect(binding?.message).toContain('branded NodeInteractiveStateBinding owner');
    expect(binding?.message).toContain('concrete Entity owner and binding facet tag');
    expect(binding?.message).toContain('entity API that owns and initializes its runtime slot');
    expect(binding?.message).toContain('will preserve an already proven NodeInteractiveStateBinding carrier');
    expect(binding?.message).toContain('will not reinterpret this literal, cast it, copy or materialize');
    for (const read of [closedRead, openRead]) {
      expect(read?.message).toContain('concrete Node owner beneath the assertion is not a Record');
      expect(read?.message).toContain('owner-preserving named-property view');
      expect(read?.message).toContain('named Node2D/interactive capability');
      expect(read?.message).toContain('while retaining');
      expect(read?.message).toContain('will not cast the owner, copy or materialize a Record');
      expect(read?.message).toContain('or add side storage');
    }
    expect(closedRead?.message).toContain('closed NodeInteractiveStateProperty key union');
    expect(openRead?.message).toContain('through a string key');
    expect(write?.message).toContain('not representation-equivalent to that keyed carrier');
    expect(write?.message).toContain('read-only named-property view cannot supply writes');
    expect(write?.message).toContain('alpha, scaleX, scaleY, visible, x, and y');
    expect(write?.message).toContain('matching boolean or number value');
    expect(write?.message).toContain('will not reinterpret or cast the owner');
    expect(write?.message).toContain('copy or materialize replacement keyed storage');
    expect(write?.message).toContain('or add side storage');
    expect(analyzeTypeScriptSourcePortability([typed]).findings).toEqual([]);
  });

  it('keeps reflective material operations on their exact concrete owners', () => {
    const asserted = input(
      'packages/materials/src/material.ts',
      `interface Material { readonly kind: string; name?: string | null }
       function equalsMaterial(a: Readonly<Material>, b: Readonly<Material>): boolean {
         if (a.kind !== b.kind) return false;
         const aFields = a as unknown as Record<string, unknown>;
         const bFields = b as unknown as Record<string, unknown>;
         const aKeys = Object.keys(aFields);
         if (aKeys.length !== Object.keys(bFields).length) return false;
         for (const key of aKeys) {
           if (!Object.hasOwn(bFields, key)) return false;
           if (aFields[key] !== bFields[key]) return false;
         }
         return true;
       }
       function copyMaterialFields(dst: Material, src: Readonly<Material>): void {
         const dstFields = dst as unknown as Record<string, unknown>;
         const srcFields = src as unknown as Record<string, unknown>;
         for (const key of Object.keys(srcFields)) dstFields[key] = srcFields[key];
       }`,
    );
    const typed = input(
      'portableMaterial.ts',
      `interface ConcreteMaterial {
         readonly kind: 'ConcreteMaterial';
         amount: number;
         name: string | null;
       }
       export function equalsMaterial(a: Readonly<ConcreteMaterial>, b: Readonly<ConcreteMaterial>): boolean {
         return a.kind === b.kind && a.amount === b.amount && a.name === b.name;
       }
       export function copyMaterialFields(dst: ConcreteMaterial, src: Readonly<ConcreteMaterial>): void {
         dst.amount = src.amount;
         dst.name = src.name;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([asserted]).findings.filter(
      (finding) => finding.rule === 'unchecked-double-assertion',
    );

    expect(findings).toHaveLength(4);
    const byRetainedSlot = (slot: 'a' | 'b' | 'dst' | 'src') =>
      findings.find((finding) => finding.message.includes(`concrete ${slot} Material owner`)) ??
      findings.find((finding) => finding.message.includes(`the ${slot} `));
    for (const slot of ['a', 'b', 'src'] as const) {
      const read = byRetainedSlot(slot);
      expect(read?.message).toContain('remains its exact concrete Material owner');
      expect(read?.message).toContain('read-only NamedProperties view');
      expect(read?.message).toContain('no Record is constructed');
      expect(read?.message).toContain('reviewed source-portability exception');
      expect(read?.message).toContain('will not cast the owner, copy or materialize a Record');
      expect(read?.message).toContain('or add side storage');
    }
    const write = byRetainedSlot('dst');
    expect(write?.message).toContain('writable Record<string, unknown> storage');
    expect(write?.message).toContain('not representation-equivalent');
    expect(write?.message).toContain('open kind family');
    expect(write?.message).toContain('per-kind typed material copier and factory');
    expect(write?.message).toContain('NamedProperties::set(String, Any) target-runtime contract');
    expect(write?.message).toContain('will not reinterpret or cast the owner');
    expect(write?.message).toContain('materialize a replacement owner');
    expect(write?.message).toContain('or add side storage');
    expect(analyzeTypeScriptSourcePortability([typed]).findings).toEqual([]);
  });

  it('keeps glTF material extension promotion on concrete material owners', () => {
    const asserted = input(
      'packages/scene3d-formats/src/gltfMaterialExtension.ts',
      `interface Material { readonly kind: string; name: string | null }
       type MaterialLike = Omit<Material, 'runtime'>;
       interface StandardPbrMaterial extends Material {
         readonly kind: 'StandardPbrMaterial';
         roughness: number;
       }
       interface ExtendedPbrMaterial extends Material {
         extensions: readonly { kind: string }[];
         readonly kind: 'ExtendedPbrMaterial';
         standard: { roughness: number };
       }
       interface Scene3DDocument { materials: MaterialLike[] }
       declare function createExtendedPbrMaterial(): ExtendedPbrMaterial;
       export function attachGltfPbrExtension(document: Scene3DDocument, index: number): boolean {
         const existing = document.materials[index];
         if (existing === undefined) return false;
         if (existing.kind === 'ExtendedPbrMaterial') {
           const extended = existing as unknown as ExtendedPbrMaterial;
           extended.extensions = [...extended.extensions, { kind: 'next' }];
           return true;
         }
         if (existing.kind !== 'StandardPbrMaterial') return false;
         const standard = existing as unknown as StandardPbrMaterial;
         const promoted = createExtendedPbrMaterial();
         promoted.standard.roughness = standard.roughness;
         document.materials[index] = promoted as unknown as MaterialLike;
         return true;
       }
       export function findGltfPbrExtension(
         document: Readonly<Scene3DDocument>,
         index: number,
       ): number | null {
         const material = document.materials[index];
         if (material === undefined || material.kind !== 'ExtendedPbrMaterial') return null;
         const extended = material as unknown as ExtendedPbrMaterial;
         return extended.extensions.length;
       }`,
    );
    const typed = input(
      'portableGltfMaterialExtension.ts',
      `interface Material { readonly kind: string; name: string | null; runtime: object }
       type EntityWithoutRuntime<Type extends Material> = Omit<Type, 'runtime'>;
       interface StandardPbrMaterial extends Material {
         readonly kind: 'StandardPbrMaterial';
         roughness: number;
       }
       interface ExtendedPbrMaterial extends Material {
         extensions: readonly { kind: string }[];
         readonly kind: 'ExtendedPbrMaterial';
         standard: { roughness: number };
       }
       type GltfMaterialLike =
         | EntityWithoutRuntime<ExtendedPbrMaterial>
         | EntityWithoutRuntime<StandardPbrMaterial>;
       interface Scene3DDocument { materials: GltfMaterialLike[] }
       declare function createExtendedPbrMaterial(): ExtendedPbrMaterial;
       export function attach(document: Scene3DDocument, index: number): boolean {
         const existing = document.materials[index];
         if (existing === undefined) return false;
         if (existing.kind === 'ExtendedPbrMaterial') {
           existing.extensions = [...existing.extensions, { kind: 'next' }];
           return true;
         }
         const promoted = createExtendedPbrMaterial();
         promoted.standard.roughness = existing.roughness;
         document.materials[index] = promoted;
         return true;
       }
       export function find(document: Readonly<Scene3DDocument>, index: number): number | null {
         const material = document.materials[index];
         return material?.kind === 'ExtendedPbrMaterial' ? material.extensions.length : null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([asserted]).findings;

    expect(findings).toHaveLength(4);
    expect(findings.every((finding) => finding.rule === 'unchecked-double-assertion')).toBe(true);
    const extended = findings.filter((finding) => finding.message.includes('recover ExtendedPbrMaterial'));
    expect(extended).toHaveLength(2);
    for (const finding of extended) {
      expect(finding.message).toContain("MaterialLike's EntityWithoutRuntime<Material> base owner");
      expect(finding.message).toContain('kind comparison checks a shared open registry string');
      expect(finding.message).toContain('does not prove that the retained Material owner');
      expect(finding.message).toContain('closed union of EntityWithoutRuntime');
      expect(finding.message).toContain('kind discriminant narrows to the exact ExtendedPbrMaterial carrier');
      expect(finding.message).toContain('will not reinterpret or cast the base owner');
      expect(finding.message).toContain('copy or materialize a replacement material');
      expect(finding.message).toContain('or add side storage');
    }
    const standard = findings.find((finding) => finding.message.includes('recover StandardPbrMaterial'));
    expect(standard?.message).toContain('for the promotion from existing');
    expect(standard?.message).toContain('independent StandardPbrMaterial owner');
    expect(standard?.message).toContain('owner-preserving checked registry recovery');
    const promoted = findings.find((finding) => finding.message.includes('store the exact promoted'));
    expect(promoted?.message).toContain('retains the base Material owner');
    expect(promoted?.message).toContain('Material and ExtendedPbrMaterial interfaces are independent owner carriers');
    expect(promoted?.message).toContain('not representation-equivalent');
    expect(promoted?.message).toContain('store promoted directly in its ExtendedPbrMaterial arm');
    expect(promoted?.message).toContain('will preserve an exact or representation-equivalent carrier');
    expect(promoted?.message).toContain('will not reinterpret or cast the owner');
    expect(promoted?.message).toContain('copy or materialize a replacement material');
    expect(promoted?.message).toContain('or add side storage');
    expect(analyzeTypeScriptSourcePortability([typed]).findings).toEqual([]);
  });

  it('keeps AWD2 material construction on the exact shaded owner', () => {
    const asserted = input(
      'packages/scene3d-formats/src/awd2MaterialHandler.ts',
      `interface Material { readonly kind: string; name: string | null; runtime: object }
       type MaterialLike = Omit<Material, 'runtime'>;
       interface SurfaceMaterial extends Material { alphaMode: 'blend' | 'opaque' }
       interface ShadedMaterial extends SurfaceMaterial {
         readonly kind: 'ShadedMaterial';
         diffuse: number;
       }
       interface Scene3DDocument { materials: MaterialLike[] }
       declare function createShadedMaterial(): ShadedMaterial;
       export function resolveAwdMaterial(
         document: Scene3DDocument,
         alpha: number | null,
         name: string,
       ): void {
         const material = createShadedMaterial() as unknown as Material;
         if (alpha !== null && alpha < 1) {
           (material as unknown as SurfaceMaterial).alphaMode = 'blend';
         }
         material.name = name.length > 0 ? name : null;
         document.materials.push(material as unknown as MaterialLike);
       }`,
    );
    const typed = input(
      'portableAwd2MaterialHandler.ts',
      `interface Material { readonly kind: string; name: string | null; runtime: object }
       type EntityWithoutRuntime<Type extends Material> = Omit<Type, 'runtime'>;
       interface SurfaceMaterial extends Material { alphaMode: 'blend' | 'opaque' }
       interface ShadedMaterial extends SurfaceMaterial {
         readonly kind: 'ShadedMaterial';
         diffuse: number;
       }
       type AwdMaterialLike = EntityWithoutRuntime<ShadedMaterial>;
       interface Scene3DDocument { materials: AwdMaterialLike[] }
       declare function createShadedMaterial(): ShadedMaterial;
       export function resolveAwdMaterial(
         document: Scene3DDocument,
         alpha: number | null,
         name: string,
       ): void {
         const material = createShadedMaterial();
         if (alpha !== null && alpha < 1) material.alphaMode = 'blend';
         material.name = name.length > 0 ? name : null;
         document.materials.push(material);
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([asserted]).findings;

    expect(findings).toHaveLength(3);
    expect(findings.every((finding) => finding.rule === 'unchecked-double-assertion')).toBe(true);
    const material = findings.find((finding) => finding.message.includes('exact ShadedMaterial owner returned'));
    expect(material?.message).toContain('replace');
    expect(material?.message).toContain('independent reference owners');
    expect(material?.message).toContain('does not make their carriers representation-equivalent');
    expect(material?.message).toContain('Keep the factory result as ShadedMaterial');
    expect(material?.message).toContain('use its declared SurfaceMaterial trailer and Material name fields directly');
    expect(material?.message).toContain('will not reinterpret or cast it as Material');
    expect(material?.message).toContain('copy or materialize a replacement owner');
    expect(material?.message).toContain('or add side storage');
    const surface = findings.find((finding) => finding.message.includes('recover SurfaceMaterial'));
    expect(surface?.message).toContain('retained only the base Material owner');
    expect(surface?.message).toContain('earlier createShadedMaterial call does not travel through');
    expect(surface?.message).toContain('declares no alphaMode');
    expect(surface?.message).toContain('assign alphaMode directly on that owner');
    expect(surface?.message).toContain('will not reinterpret or cast the base owner');
    expect(surface?.message).toContain('copy or materialize a replacement surface material');
    expect(surface?.message).toContain('or add side storage');
    const like = findings.find((finding) => finding.message.includes('from Material to MaterialLike'));
    expect(like?.message).toContain('identity-preserving view of that same Material owner');
    expect(like?.message).toContain('bridge is representation-equivalent');
    expect(like?.message).toContain('carrier no-op');
    expect(like?.message).toContain('cannot restore the ShadedMaterial owner erased by the earlier assertion');
    expect(like?.message).toContain('concrete EntityWithoutRuntime<ShadedMaterial> arm');
    expect(like?.message).toContain('will preserve the same represented Material carrier here');
    expect(like?.message).toContain('will not use that equivalence to cast back to ShadedMaterial');
    expect(like?.message).toContain('copy or materialize a replacement');
    expect(like?.message).toContain('or add side storage');
    expect(analyzeTypeScriptSourcePortability([typed]).findings).toEqual([]);
  });

  it('keeps signal dispatch binding on represented callable implementations', () => {
    const asserted = input(
      'packages/signals/src/slot.ts',
      `const nullSignalEmit = (): void => {};
       interface Signal<T extends (...args: any[]) => void> {
         data: SignalData<T> | null;
         emit: T;
       }
       interface SignalData<T extends (...args: any[]) => void> {
         depth: number;
         slots: (T | null)[];
       }
       export function clearSignal<T extends (...args: any[]) => void>(signal: Signal<T>): void {
         signal.emit = nullSignalEmit as unknown as T;
         signal.data = null;
       }
       export function disconnectSignal<T extends (...args: any[]) => void>(signal: Signal<T>): void {
         signal.emit = nullSignalEmit as unknown as T;
       }
       function makeDispatch<T extends (...args: any[]) => void>(
         signal: Signal<T>,
         data: SignalData<T>,
       ): T {
         return ((...args: any[]) => {
           for (const slot of data.slots) if (slot !== null) slot(...args);
           void signal;
         }) as unknown as T;
       }
       function compactSignalData<T extends (...args: any[]) => void>(
         signal: Signal<T>,
       ): void {
         signal.emit = nullSignalEmit as unknown as T;
       }`,
    );
    const typed = input(
      'portableSignalSlot.ts',
      `type SignalDispatch<Args extends readonly unknown[]> = (...args: Args) => void;
       interface Signal<Args extends readonly unknown[]> {
         data: SignalData<Args> | null;
         emit: SignalDispatch<Args>;
       }
       interface SignalData<Args extends readonly unknown[]> {
         slots: (SignalDispatch<Args> | null)[];
       }
       function createNullSignalEmit<Args extends readonly unknown[]>(): SignalDispatch<Args> {
         return (..._args: Args): void => {};
       }
       function makeDispatch<Args extends readonly unknown[]>(
         signal: Signal<Args>,
         data: SignalData<Args>,
       ): SignalDispatch<Args> {
         return (...args: Args): void => {
           for (const slot of data.slots) if (slot !== null) slot(...args);
           void signal;
         };
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([asserted]).findings;

    expect(findings).toHaveLength(4);
    expect(findings.every((finding) => finding.rule === 'unchecked-double-assertion')).toBe(true);
    const noOps = findings.filter((finding) => finding.message.includes('zero-argument nullSignalEmit'));
    expect(noOps).toHaveLength(3);
    for (const finding of noOps) {
      expect(finding.message).toContain('open callable type parameter T');
      expect(finding.message).toContain('bridge is not representation equivalence');
      expect(finding.message).toContain('Preserve the Signal<T> owner and every stored T slot');
      expect(finding.message).toContain('checked callable-signature binding contract');
      expect(finding.message).toContain("forwards T's exact parameters or deliberately ignores them");
      expect(finding.message).toContain('named Signal argument-tuple/dispatch type');
      expect(finding.message).toContain('may bind this represented callable implementation to T');
      expect(finding.message).toContain('will not route it through Any');
      expect(finding.message).toContain('cast between callable carriers');
      expect(finding.message).toContain('copy or materialize the Signal or its slots');
      expect(finding.message).toContain('or add side storage');
      expect(finding.message).toContain('non-callable or genuinely erased source must be refused');
    }
    const dispatch = findings.find((finding) => finding.message.includes('newly created dispatch implementation'));
    expect(dispatch?.message).toContain('rest arguments were declared as any[]');
    expect(dispatch?.message).toContain('captured Signal<T>, SignalData<T>, and every stored T slot by reference');
    expect(dispatch?.message).toContain('checked callable-signature binding contract');
    expect(dispatch?.message).toContain("T's instantiated parameter list");
    expect(dispatch?.message).toContain('named Signal argument tuple');
    expect(dispatch?.message).toContain('may bind this represented function implementation to T');
    expect(dispatch?.message).toContain('will not route it through Any');
    expect(dispatch?.message).toContain('reinterpret or cast a callable owner');
    expect(dispatch?.message).toContain('copy or materialize the signal/data/slot owners');
    expect(dispatch?.message).toContain('or add side storage');
    expect(dispatch?.message).toContain('non-callable or genuinely erased source must be refused');
    expect(analyzeTypeScriptSourcePortability([typed]).findings).toEqual([]);
  });

  it('keeps signal initialization, safe teardown, and tracked wrappers on represented callables', () => {
    const signal = input(
      'packages/signals/src/signal.ts',
      `declare const nullSignalEmit: () => void;
       export function initializeSignal<T extends (...args: any[]) => void>(
         out: EntityConstruction<Signal<T>>,
       ): void {
         out.emit = nullSignalEmit as unknown as T;
         out.data = null;
       }`,
    );
    const safe = input(
      'packages/signals/src/safe.ts',
      `declare const nullSignalEmit: () => void;
       function compactSignalData<T extends (...args: any[]) => void>(
         signal: Signal<T>,
         data: SignalData<T>,
       ): void {
         if (data.slots.length === 0 && signal.data === data) {
           signal.emit = nullSignalEmit as unknown as T;
           signal.data = null;
         }
       }`,
    );
    const connection = input(
      'packages/signals/src/connection.ts',
      `export function connectSignalTracked<T extends (...args: any[]) => void>(
         signal: Signal<T>,
         slot: T,
       ): SignalConnection<T> {
         const connection: SignalConnection<T> = { connected: true, paused: false, signal, slot };
         const once = true;
         const trackedSlot = ((...args: Parameters<T>): void => {
           if (connection.paused) return;
           if (once) connection.connected = false;
           slot(...args);
         }) as unknown as T;
         connection.slot = trackedSlot;
         return connection;
       }`,
    );
    const typed = input(
      'portableSignalCallables.ts',
      `type SignalDispatch<Args extends readonly unknown[]> = (...args: Args) => void;
       interface Signal<Args extends readonly unknown[]> {
         emit: SignalDispatch<Args>;
       }
       interface SignalConnection<Args extends readonly unknown[]> {
         paused: boolean;
         slot: SignalDispatch<Args>;
       }
       function createNullSignalEmit<Args extends readonly unknown[]>(): SignalDispatch<Args> {
         return (..._args: Args): void => {};
       }
       function initializeSignal<Args extends readonly unknown[]>(signal: Signal<Args>): void {
         signal.emit = createNullSignalEmit<Args>();
       }
       function createTrackedSlot<Args extends readonly unknown[]>(
         connection: SignalConnection<Args>,
         slot: SignalDispatch<Args>,
       ): SignalDispatch<Args> {
         return (...args: Args): void => {
           if (!connection.paused) slot(...args);
         };
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([signal, safe, connection]).findings;

    expect(findings).toHaveLength(3);
    expect(findings.every((finding) => finding.rule === 'unchecked-double-assertion')).toBe(true);
    const bySource = new Map(findings.map((finding) => [finding.module.source, finding]));
    const initialized = bySource.get('packages/signals/src/signal.ts');
    expect(initialized?.message).toContain('EntityConstruction<Signal<T>> owner');
    expect(initialized?.message).toContain('checked callable-signature binding contract');
    expect(initialized?.message).toContain("deliberately ignores T's instantiated arguments");
    expect(initialized?.message).toContain('will not route it through Any');
    expect(initialized?.message).toContain('copy or materialize the entity under construction');
    expect(initialized?.message).toContain('or add side storage');
    const safeTeardown = bySource.get('packages/signals/src/safe.ts');
    expect(safeTeardown?.message).toContain('exact Signal<T> and SignalData<T> owners');
    expect(safeTeardown?.message).toContain('safe-dispatch snapshots and every stored T slot');
    expect(safeTeardown?.message).toContain('checked callable-signature binding contract');
    expect(safeTeardown?.message).toContain('will not route it through Any');
    expect(safeTeardown?.message).toContain('copy or materialize the signal/data owners');
    expect(safeTeardown?.message).toContain('or add side storage');
    const tracked = bySource.get('packages/signals/src/connection.ts');
    expect(tracked?.message).toContain('trackedSlot closure');
    expect(tracked?.message).toContain('Parameters<T>');
    expect(tracked?.message).toContain('captured SignalConnection<T> and exact T slot');
    expect(tracked?.message).toContain('checked callable-signature binding contract');
    expect(tracked?.message).toContain("T's instantiated parameter list");
    expect(tracked?.message).toContain('will not route it through Any');
    expect(tracked?.message).toContain('copy or materialize the connection or slot owners');
    expect(tracked?.message).toContain('or add side storage');
    expect(analyzeTypeScriptSourcePortability([typed]).findings).toEqual([]);
  });

  it('refuses re-parameterizing represented generic callable owners', () => {
    const asserted = input(
      'packages/signals/src/connection.ts',
      `export function retainInScope<T extends (...args: any[]) => void>(
         connection: SignalConnection<T>,
         scope: SignalScope,
       ): void {
         const retained: SignalConnection<T> = connection;
         scope.connections.push(retained as unknown as SignalConnection<(...args: any[]) => void>);
       }`,
    );
    const exact = input(
      'exactGenericOwner.ts',
      `export function retain<T extends (...args: any[]) => void>(
         connection: SignalConnection<T>,
       ): SignalConnection<T> {
         const retained: SignalConnection<T> = connection;
         return retained as unknown as SignalConnection<T>;
       }`,
    );
    const typed = input(
      'portableSignalScope.ts',
      `interface SignalScope { disconnectors: (() => void)[] }
       function retainInScope<T extends (...args: any[]) => void>(
         connection: SignalConnection<T>,
         scope: SignalScope,
       ): void {
         scope.disconnectors.push((): void => disconnectSignalConnection(connection));
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([asserted]).findings;

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'unchecked-double-assertion', subject: 'function:retainInScope' });
    expect(findings[0]?.message).toContain('represented SignalConnection<T> owner');
    expect(findings[0]?.message).toContain('SignalConnection<(...args: any[]) => void>');
    expect(findings[0]?.message).toContain('type arguments determine the member and callable cells');
    expect(findings[0]?.message).toContain('store an operation closure that captures this exact owner');
    expect(findings[0]?.message).toContain('explicit type-erased handle and target-runtime contract');
    expect(findings[0]?.message).toContain('will not treat type-parameter variance as representation equivalence');
    expect(findings[0]?.message).toContain('reinterpret or cast the owner');
    expect(findings[0]?.message).toContain('copy or materialize a replacement');
    expect(findings[0]?.message).toContain('or add side storage');
    const exactFinding = analyzeTypeScriptSourcePortability([exact]).findings[0];
    expect(exactFinding?.message).toBe(
      'function:retain uses a double assertion through unknown; replace it with a checked conversion or a narrower source type.',
    );
    expect(analyzeTypeScriptSourcePortability([typed]).findings).toEqual([]);
  });

  it('requires one shared closed domain for a nested opaque parameter property', () => {
    const opaque = input(
      'command.ts',
      `export function createSetNodePropertyCommandBatch(
         entries: readonly Readonly<{ property: string; value: unknown }>[],
       ): void { void entries; }`,
    );
    const explicit = input(
      'portable-command.ts',
      `type CommandPropertyValue = boolean | number | string | null;
       interface CommandPropertyEntry {
         readonly after: CommandPropertyValue;
         readonly before: CommandPropertyValue;
       }
       export function createSetNodePropertyCommandBatch(
         entries: readonly Readonly<{ property: string; value: CommandPropertyValue }>[],
       ): CommandPropertyEntry[] {
         return entries.map((entry) => ({ after: entry.value, before: entry.value }));
       }`,
    );

    expect(analyzeTypeScriptSourcePortability([opaque]).findings).toMatchObject([
      {
        message:
          'function:createSetNodePropertyCommandBatch/parameter:entries/property:value exposes unknown; no exact runtime value domain can be recovered from that annotation or its downstream uses. Replace it with a named closed value type shared by the boundary, its storage, and its consumers; when intentional erasure is the contract, record a reviewed source-portability exception instead.',
        rule: 'opaque-value-domain',
        subject: 'function:createSetNodePropertyCommandBatch/parameter:entries/property:value',
      },
    ]);
    expect(analyzeTypeScriptSourcePortability([explicit]).findings).toEqual([]);
  });

  it('traces Flight log records to their producer normalization boundary', () => {
    const opaque = input(
      'packages/types/src/Log.ts',
      `type LogData = string | Readonly<Record<string, unknown>>;
       interface LogContext { fields: Readonly<Record<string, unknown>> }
       interface LogSpan { fields: Readonly<Record<string, unknown>> }`,
    );
    const closed = input(
      'packages/types/src/Log.ts',
      `type LogFieldValue = boolean | number | string | null;
       type LogData = string | Readonly<Record<string, LogFieldValue>>;
       interface LogContext { fields: Readonly<Record<string, LogFieldValue>> }
       interface LogSpan { fields: Readonly<Record<string, LogFieldValue>> }`,
    );
    const controls = [
      input('packages/types/src/Other.ts', 'type LogData = string | Readonly<Record<string, unknown>>;'),
      input('packages/other/src/Log.ts', 'interface LogContext { fields: Readonly<Record<string, unknown>> }'),
      input('packages/types/src/Log.ts', 'type LogData = unknown;'),
      input('packages/types/src/Log.ts', 'interface LogSpan { fields: unknown }'),
      input('packages/types/src/Log.ts', 'interface LogContext { fields: Readonly<Record<string, any>> }'),
    ];

    const report = analyzeTypeScriptSourcePortability([opaque]);
    expect(report.findings.map(({ subject }) => subject)).toEqual([
      'interface:LogContext/property:fields',
      'interface:LogSpan/property:fields',
      'type:LogData',
    ]);
    const alias = report.findings.find(({ subject }) => subject === 'type:LogData');
    expect(alias?.message).toContain('through span and context merging');
    expect(alias?.message).toContain('Normalize each producer before LogEntry construction');
    for (const finding of report.findings.filter(({ subject }) => subject.endsWith('/property:fields'))) {
      expect(finding.message).toContain('merges these fields into LogData before LogEntry emission');
      expect(finding.message).toContain('same named closed LogFieldValue domain as LogData and every sink');
    }
    for (const finding of report.findings) {
      expect(finding.message).toContain('reviewed source-portability exception for this exact');
      expect(finding.message).toContain('target-specific Any carrier');
      expect(finding.message).toContain('insert a cast');
      expect(finding.message).toContain('copy or materialize the record');
    }
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message }) => !message.includes('LogFieldValue'),
        ),
      ).toBe(true);
    }
  });

  it('preserves heterogeneous command property slots as reviewed identity transport', () => {
    const opaque = input(
      'packages/types/src/Command.ts',
      `interface CommandPropertyEntry {
         readonly after: unknown;
         readonly before: unknown;
         readonly property: string;
       }`,
    );
    const closed = input(
      'packages/types/src/Command.ts',
      `type CommandPropertyValue = boolean | number | string | null;
       interface CommandPropertyEntry {
         readonly after: CommandPropertyValue;
         readonly before: CommandPropertyValue;
         readonly property: string;
       }`,
    );
    const controls = [
      input('packages/types/src/Other.ts', 'interface CommandPropertyEntry { readonly after: unknown }'),
      input('packages/other/src/Command.ts', 'interface CommandPropertyEntry { readonly before: unknown }'),
      input('packages/types/src/Command.ts', 'interface OtherEntry { readonly after: unknown }'),
      input('packages/types/src/Command.ts', 'interface CommandPropertyEntry { readonly after?: unknown }'),
      input('packages/types/src/Command.ts', 'interface CommandPropertyEntry { readonly before: any }'),
    ];

    const report = analyzeTypeScriptSourcePortability([opaque]);
    expect(report.findings.map(({ subject }) => subject)).toEqual([
      'interface:CommandPropertyEntry/property:after',
      'interface:CommandPropertyEntry/property:before',
    ]);
    expect(report.findings[0]?.message).toContain('capture the caller-supplied value');
    expect(report.findings[0]?.message).toContain('execute or redo');
    expect(report.findings[1]?.message).toContain('read the current node property');
    expect(report.findings[1]?.message).toContain('on undo');
    for (const finding of report.findings) {
      expect(finding.message).toContain('genuinely opaque');
      expect(finding.message).toContain('named closed CommandPropertyValue domain');
      expect(finding.message).toContain('reviewed source-portability exception for this exact property');
      expect(finding.message).toContain('target-specific Any carrier');
      expect(finding.message).toContain('insert a cast');
      expect(finding.message).toContain('copy or materialize the value');
    }
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message }) => !message.includes('CommandPropertyValue'),
        ),
      ).toBe(true);
    }

    const reviewed = analyzeTypeScriptSourcePortability([opaque], {
      exceptionPolicy: {
        exceptions: report.findings.map((finding) => ({
          findingIdentity: finding.identity,
          reason: 'The command binding returns each heterogeneous property value only to its originating slot.',
          rule: 'opaque-value-domain' as const,
        })),
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.acceptedExceptions).toHaveLength(2);
  });

  it('keeps browser notification data at the exact structured-clone provider boundary', () => {
    const opaque = input(
      'packages/types/src/Notification.ts',
      `interface NotificationRequest { data?: unknown }
       interface WebNotificationOptions { data?: unknown }
       interface WebServiceWorkerNotificationInstance { readonly data?: unknown }`,
    );
    const closed = input(
      'packages/types/src/Notification.ts',
      `type NotificationData = boolean | number | string | null;
       interface NotificationRequest { data?: NotificationData }
       interface WebNotificationOptions { data?: NotificationData }
       interface WebServiceWorkerNotificationInstance { readonly data?: NotificationData }`,
    );
    const controls = [
      input('packages/types/src/Other.ts', 'interface NotificationRequest { data?: unknown }'),
      input('packages/other/src/Notification.ts', 'interface WebNotificationOptions { data?: unknown }'),
      input('packages/types/src/Notification.ts', 'interface OtherRequest { data?: unknown }'),
      input('packages/types/src/Notification.ts', 'interface NotificationRequest { data: unknown }'),
      input('packages/types/src/Notification.ts', 'interface WebNotificationOptions { data?: any }'),
    ];

    const report = analyzeTypeScriptSourcePortability([opaque]);
    expect(report.findings.map(({ subject }) => subject)).toEqual([
      'interface:NotificationRequest/property:data',
      'interface:WebNotificationOptions/property:data',
      'interface:WebServiceWorkerNotificationInstance/property:data',
    ]);
    expect(report.findings[0]?.message).toContain('forward the same value through WebNotificationOptions.data');
    expect(report.findings[0]?.message).toContain('a ScheduledNotification can retain its request');
    expect(report.findings[1]?.message).toContain('browser-provider leg of NotificationRequest.data');
    expect(report.findings[2]?.message).toContain('active-list adapter reads only tag identity');
    for (const finding of report.findings) {
      expect(finding.message).toContain('named closed NotificationData domain');
      expect(finding.message).toContain('reviewed source-portability exception for this exact property');
      expect(finding.message).toContain('target-specific Any carrier');
      expect(finding.message).toContain('insert a cast');
      expect(finding.message).toContain('copy or materialize the payload');
    }
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message }) => !message.includes('NotificationData'),
        ),
      ).toBe(true);
    }
  });

  it('recognizes the paired HostAppLoop handle as a provider-owned cancellation token', () => {
    const opaque = input(
      'packages/types/src/HostAppLoop.ts',
      `interface HostAppLoopCapability {
         requestFrame(callback: (time: number) => void): unknown;
         cancelFrame(handle: unknown): void;
       }`,
    );
    const closed = input(
      'packages/types/src/HostAppLoop.ts',
      `type AppLoopFrameHandle = number;
       interface HostAppLoopCapability {
         requestFrame(callback: (time: number) => void): AppLoopFrameHandle;
         cancelFrame(handle: AppLoopFrameHandle): void;
       }`,
    );
    const controls = [
      input(
        'packages/types/src/Other.ts',
        'interface HostAppLoopCapability { requestFrame(callback: () => void): unknown }',
      ),
      input(
        'packages/other/src/HostAppLoop.ts',
        'interface HostAppLoopCapability { cancelFrame(handle: unknown): void }',
      ),
      input('packages/types/src/HostAppLoop.ts', 'interface OtherLoop { cancelFrame(handle: unknown): void }'),
      input('packages/types/src/HostAppLoop.ts', 'interface HostAppLoopCapability { cancelFrame(handle: any): void }'),
    ];

    const report = analyzeTypeScriptSourcePortability([opaque]);
    expect(report.findings.map(({ subject }) => subject)).toEqual([
      'interface:HostAppLoopCapability/method:cancelFrame.parameter:handle',
      'interface:HostAppLoopCapability/method:requestFrame.return',
    ]);
    expect(report.findings[0]?.message).toContain('sole semantic consumer');
    expect(report.findings[1]?.message).toContain('stores it only in private LoopState');
    for (const finding of report.findings) {
      expect(finding.message).toContain('paired identity transport is genuinely opaque');
      expect(finding.message).toContain('named closed AppLoopFrameHandle domain');
      expect(finding.message).toContain('reviewed source-portability exception for this exact');
      expect(finding.message).toContain("will not assume the web provider's numeric handle");
      expect(finding.message).toContain('target-specific Any carrier');
      expect(finding.message).toContain('insert a cast');
      expect(finding.message).toContain('copy or materialize the token');
    }
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message }) => !message.includes('AppLoopFrameHandle'),
        ),
      ).toBe(true);
    }

    const reviewed = analyzeTypeScriptSourcePortability([opaque], {
      exceptionPolicy: {
        exceptions: report.findings.map((finding) => ({
          findingIdentity: finding.identity,
          reason: 'The provider token is returned only to the same provider for cancellation.',
          rule: 'opaque-value-domain' as const,
        })),
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.acceptedExceptions).toHaveLength(2);
  });

  it('keeps AppLoop frame-handle storage on the paired provider boundary', () => {
    const opaque = input(
      'packages/app/src/appLoop.ts',
      `interface LoopState {
         frameHandle: unknown;
         lastTime: number;
       }`,
    );
    const closed = input(
      'packages/app/src/appLoop.ts',
      `type AppLoopFrameHandle = number;
       interface LoopState {
         frameHandle: AppLoopFrameHandle;
         lastTime: number;
       }`,
    );
    const controls = [
      input('packages/app/src/otherLoop.ts', 'interface LoopState { frameHandle: unknown }'),
      input('packages/other/src/appLoop.ts', 'interface LoopState { frameHandle: unknown }'),
      input('packages/app/src/appLoop.ts', 'interface OtherState { frameHandle: unknown }'),
      input('packages/app/src/appLoop.ts', 'interface LoopState { frameHandle?: unknown }'),
      input('packages/app/src/appLoop.ts', 'interface LoopState { frameHandle: any }'),
      input('packages/app/src/appLoop.ts', 'interface LoopState { frameHandle: unknown | null }'),
      input('packages/app/src/appLoop.ts', 'interface LoopState { handle: unknown }'),
    ];

    const report = analyzeTypeScriptSourcePortability([opaque]);
    const finding = report.findings[0];
    if (!finding) throw new Error('Expected an opaque AppLoop frame-handle finding');

    expect(report.findings).toMatchObject([
      { rule: 'opaque-value-domain', subject: 'interface:LoopState/property:frameHandle' },
    ]);
    expect(finding.message).toContain('private storage leg of HostAppLoopCapability');
    expect(finding.message).toContain('backend.requestFrame(tick)');
    expect(finding.message).toContain('backend.cancelFrame on the same retained capability');
    expect(finding.message).toContain('Pause, frame-rate throttling, normal rescheduling, and initial scheduling');
    expect(finding.message).toContain('initial null is never passed to cancelFrame');
    expect(finding.message).toContain('paired identity transport is genuinely provider-opaque');
    expect(finding.message).toContain('reviewed source-portability exception for this exact property');
    expect(finding.message).toContain('requestFrame remains its sole non-sentinel producer');
    expect(finding.message).toContain('cancelFrame remains its sole semantic consumer');
    expect(finding.message).toContain('does not justify the null as unknown assertion');
    expect(finding.message).toContain('named closed AppLoopFrameHandle domain');
    expect(finding.message).toContain("will not assume the web provider's numeric handle");
    expect(finding.message).toContain('target-specific Any carrier');
    expect(finding.message).toContain('retain or insert a cast');
    expect(finding.message).toContain('copy or materialize the token');
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message }) => !message.includes('private storage leg of HostAppLoopCapability'),
        ),
      ).toBe(true);
    }

    const reviewed = analyzeTypeScriptSourcePortability([opaque], {
      exceptionPolicy: {
        exceptions: [
          {
            findingIdentity: finding.identity,
            reason: 'The private token is returned only to the same provider for cancellation.',
            rule: 'opaque-value-domain',
          },
        ],
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.acceptedExceptions).toHaveLength(1);
  });

  it('keeps batch command property values as exact identity transport', () => {
    const opaque = input(
      'packages/command/src/command.ts',
      `interface NodeAny { readonly id: number }
       function createSetNodePropertyCommandBatch(
         entries: readonly Readonly<{ property: string; target: NodeAny; value: unknown }>[],
       ): void { void entries; }`,
    );
    const closed = input(
      'packages/command/src/command.ts',
      `interface NodeAny { readonly id: number }
       type CommandPropertyValue = boolean | number | string | null;
       function createSetNodePropertyCommandBatch(
         entries: readonly Readonly<{ property: string; target: NodeAny; value: CommandPropertyValue }>[],
       ): void { void entries; }`,
    );
    const controls = [
      input(
        'packages/command/src/otherCommand.ts',
        `function createSetNodePropertyCommandBatch(
           entries: readonly Readonly<{ property: string; value: unknown }>[],
         ): void { void entries; }`,
      ),
      input(
        'packages/other/src/command.ts',
        `function createSetNodePropertyCommandBatch(
           entries: readonly Readonly<{ property: string; value: unknown }>[],
         ): void { void entries; }`,
      ),
      input(
        'packages/command/src/command.ts',
        `function createOtherCommand(
           entries: readonly Readonly<{ property: string; value: unknown }>[],
         ): void { void entries; }`,
      ),
      input(
        'packages/command/src/command.ts',
        `function createSetNodePropertyCommandBatch(
           entries: readonly Readonly<{ payload: unknown; property: string }>[],
         ): void { void entries; }`,
      ),
      input(
        'packages/command/src/command.ts',
        `function createSetNodePropertyCommandBatch(
           entries: readonly Readonly<{ property: string; value?: unknown }>[],
         ): void { void entries; }`,
      ),
      input(
        'packages/command/src/command.ts',
        `function createSetNodePropertyCommandBatch(
           entries: readonly Readonly<{ property: string; value: any }>[],
         ): void { void entries; }`,
      ),
      input(
        'packages/command/src/command.ts',
        `function createSetNodePropertyCommandBatch(
           changes: readonly Readonly<{ property: string; value: unknown }>[],
         ): void { void changes; }`,
      ),
    ];

    const report = analyzeTypeScriptSourcePortability([opaque]);
    const finding = report.findings[0];
    if (!finding) throw new Error('Expected an opaque batch command property finding');

    expect(report.findings).toMatchObject([
      {
        rule: 'opaque-value-domain',
        subject: 'function:createSetNodePropertyCommandBatch/parameter:entries/property:value',
      },
    ]);
    expect(finding.message).toContain('caller-provided after-side of a heterogeneous node-property command');
    expect(finding.message).toContain('readNodeProperty captures the matching before value');
    expect(finding.message).toContain('original before and newest after');
    expect(finding.message).toContain('execute and redo write after');
    expect(finding.message).toContain('undo writes before');
    expect(finding.message).toContain('genuinely opaque identity transport');
    expect(finding.message).toContain('reviewed source-portability exception for this exact parameter property');
    expect(finding.message).toContain('named closed CommandPropertyValue domain');
    expect(finding.message).toContain('property-discriminated entry arms');
    expect(finding.message).toContain('does not prove indexed storage on NodeAny');
    expect(finding.message).toContain('double assertions in readNodeProperty and writeNodeProperty');
    expect(finding.message).toContain('target-specific Any carrier');
    expect(finding.message).toContain('retain or insert a cast');
    expect(finding.message).toContain('copy or materialize the value');
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message }) => !message.includes('caller-provided after-side'),
        ),
      ).toBe(true);
    }

    const reviewed = analyzeTypeScriptSourcePortability([opaque], {
      exceptionPolicy: {
        exceptions: [
          {
            findingIdentity: finding.identity,
            reason: 'The command core returns the captured value only to its originating target property.',
            rule: 'opaque-value-domain',
          },
        ],
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.acceptedExceptions).toHaveLength(1);
  });

  it('keeps initializeNode runtime installation on its declared computed slot', () => {
    const declarations = `declare const EntityRuntimeKey: unique symbol;
       interface NodeRuntime<Traits extends object> { readonly traits?: Traits }
       interface Node<Traits extends object> {
         [EntityRuntimeKey]: NodeRuntime<Traits> | undefined;
       }
       type EntityConstruction<Value> = { -readonly [Key in keyof Value]: Value[Key] };
       type NodeRuntimeFactory<Runtime> = () => Runtime;`;
    const opaque = input(
      'packages/node/src/node.ts',
      `${declarations}
       function initializeNode<Traits extends object, Runtime extends NodeRuntime<Traits>>(
         node: EntityConstruction<Node<Traits>>,
         runtimeFactory: NodeRuntimeFactory<Runtime>,
       ): void {
         (node as { [EntityRuntimeKey]?: unknown })[EntityRuntimeKey] = runtimeFactory();
       }`,
    );
    const closed = input(
      'packages/node/src/node.ts',
      `${declarations}
       function initializeNode<Traits extends object, Runtime extends NodeRuntime<Traits>>(
         node: EntityConstruction<Node<Traits>>,
         runtimeFactory: NodeRuntimeFactory<Runtime>,
       ): void {
         node[EntityRuntimeKey] = runtimeFactory();
       }`,
    );
    const controls = [
      input(
        'packages/node/src/otherNode.ts',
        `${declarations}
         function initializeNode(node: Node<object>, runtimeFactory: () => NodeRuntime<object>): void {
           (node as { [EntityRuntimeKey]?: unknown })[EntityRuntimeKey] = runtimeFactory();
         }`,
      ),
      input(
        'packages/other/src/node.ts',
        `${declarations}
         function initializeNode(node: Node<object>, runtimeFactory: () => NodeRuntime<object>): void {
           (node as { [EntityRuntimeKey]?: unknown })[EntityRuntimeKey] = runtimeFactory();
         }`,
      ),
      input(
        'packages/node/src/node.ts',
        `${declarations}
         function initializeOtherNode(node: Node<object>, runtimeFactory: () => NodeRuntime<object>): void {
           (node as { [EntityRuntimeKey]?: unknown })[EntityRuntimeKey] = runtimeFactory();
         }`,
      ),
      input(
        'packages/node/src/node.ts',
        `${declarations}
         function initializeNode(out: Node<object>, runtimeFactory: () => NodeRuntime<object>): void {
           (out as { [EntityRuntimeKey]?: unknown })[EntityRuntimeKey] = runtimeFactory();
         }`,
      ),
      input(
        'packages/node/src/node.ts',
        `${declarations}
         function initializeNode(node: Node<object>, runtimeFactory: () => NodeRuntime<object>): void {
           (node as { [EntityRuntimeKey]: unknown })[EntityRuntimeKey] = runtimeFactory();
         }`,
      ),
      input(
        'packages/node/src/node.ts',
        `${declarations}
         function initializeNode(node: Node<object>, runtimeFactory: () => NodeRuntime<object>): void {
           (node as { [EntityRuntimeKey]?: any })[EntityRuntimeKey] = runtimeFactory();
         }`,
      ),
      input(
        'packages/node/src/node.ts',
        `${declarations}
         function initializeNode(node: Node<object>, runtimeFactory: () => NodeRuntime<object>): void {
           (node as { [EntityRuntimeKey]?: unknown; ready?: boolean })[EntityRuntimeKey] = runtimeFactory();
         }`,
      ),
      input(
        'packages/node/src/node.ts',
        `${declarations}
         function initializeNode(
           node: Node<object>,
           runtimeFactory: () => NodeRuntime<object>,
           runtime: NodeRuntime<object>,
         ): void {
           (node as { [EntityRuntimeKey]?: unknown })[EntityRuntimeKey] = runtime;
           void runtimeFactory;
         }`,
      ),
    ];

    const report = analyzeTypeScriptSourcePortability([opaque]);
    const finding = report.findings[0];
    if (!finding) throw new Error('Expected an opaque computed runtime-slot finding');

    expect(report.findings).toMatchObject([
      {
        rule: 'opaque-value-domain',
        subject: 'function:initializeNode/property:computed',
      },
    ]);
    expect(finding.message).toContain('direct runtimeFactory() write into the existing node owner');
    expect(finding.message).toContain('Node<Traits>[EntityRuntimeKey]: NodeRuntime<Traits> | undefined');
    expect(finding.message).toContain('Runtime extends NodeRuntime<Traits>');
    expect(finding.message).toContain('allocateEntity created this same owner');
    expect(finding.message).toContain('getNodeRuntime reads the same slot');
    expect(finding.message).toContain('direct typed node[EntityRuntimeKey] = runtimeFactory() assignment');
    expect(finding.message).toContain('repair that relation in semantic lowering');
    expect(finding.message).toContain('reviewed source-portability exception is not justified');
    expect(finding.message).toContain('target-specific Any carrier');
    expect(finding.message).toContain('retain or insert a cast');
    expect(finding.message).toContain('copy or materialize the node or runtime');
    expect(finding.message).toContain('side storage');
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message }) => !message.includes('direct runtimeFactory() write into the existing node owner'),
        ),
      ).toBe(true);
    }
  });

  it('preserves animation target and marker payloads as exact domain-owned references', () => {
    const target = input(
      'packages/types/src/AnimationChannel.ts',
      'interface AnimationChannel { track: AnimationTrack; targetRef: unknown }',
    );
    const event = input(
      'packages/types/src/AnimationClipEvent.ts',
      'interface AnimationClipEvent { name: string; payload: unknown; time: number }',
    );
    const closed = [
      input(
        'packages/types/src/AnimationChannel.ts',
        `type AnimationTargetRef = { readonly kind: 'node'; readonly nodeId: string }
           | { readonly boneIndex: number; readonly kind: 'bone' };
         interface AnimationChannel { track: AnimationTrack; targetRef: AnimationTargetRef }`,
      ),
      input(
        'packages/types/src/AnimationClipEvent.ts',
        `type AnimationClipEventPayload =
           | { readonly kind: 'audio'; readonly resource: string }
           | { readonly kind: 'marker' };
         interface AnimationClipEvent { name: string; payload: AnimationClipEventPayload; time: number }`,
      ),
    ];
    const controls = [
      input('packages/types/src/Other.ts', 'interface AnimationChannel { targetRef: unknown }'),
      input('packages/other/src/AnimationChannel.ts', 'interface AnimationChannel { targetRef: unknown }'),
      input('packages/types/src/AnimationChannel.ts', 'interface AnimationChannel { targetRef?: unknown }'),
      input('packages/types/src/AnimationChannel.ts', 'interface AnimationChannel { targetRef: any }'),
      input('packages/types/src/AnimationClipEvent.ts', 'interface AnimationClipEvent { payload?: unknown }'),
      input('packages/types/src/AnimationClipEvent.ts', 'interface AnimationClipEvent { payload: unknown[] }'),
      input('packages/types/src/AnimationClipEvent.ts', 'interface OtherEvent { payload: unknown }'),
    ];

    const report = analyzeTypeScriptSourcePortability([event, target]);
    expect(report.findings.map(({ subject }) => subject)).toEqual([
      'interface:AnimationChannel/property:targetRef',
      'interface:AnimationClipEvent/property:payload',
    ]);
    expect(report.findings[0]?.message).toContain('crossfade and layer composition use identity equality only');
    expect(report.findings[0]?.message).toContain('genuinely domain-opaque extensibility contract');
    expect(report.findings[0]?.message).toContain('named closed tagged AnimationTargetRef domain');
    expect(report.findings[1]?.message).toContain('cloneAnimationClip carries the same payload reference');
    expect(report.findings[1]?.message).toContain('retained by the clip but remains genuinely domain-opaque');
    expect(report.findings[1]?.message).toContain('named closed AnimationClipEventPayload domain');
    for (const finding of report.findings) {
      expect(finding.message).toContain('reviewed source-portability exception for this exact property');
      expect(finding.message).toContain('target-specific Any carrier');
      expect(finding.message).toContain('insert a cast');
      expect(finding.message).toMatch(/copy or materialize the (?:target reference|payload)/u);
    }
    expect(analyzeTypeScriptSourcePortability(closed).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message }) => !message.includes('genuinely domain-opaque'),
        ),
      ).toBe(true);
    }

    const reviewed = analyzeTypeScriptSourcePortability([event, target], {
      exceptionPolicy: {
        exceptions: report.findings.map((finding) => ({
          findingIdentity: finding.identity,
          reason: 'The animation core preserves the domain-owned reference without interpreting or serializing it.',
          rule: 'opaque-value-domain' as const,
        })),
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.acceptedExceptions).toHaveLength(2);
  });

  it('keeps native window, video-stream, and surface identities inside their exact providers', () => {
    const windowHandle = input('packages/types/src/AppWindow.ts', 'type NativeWindowHandle = unknown;');
    const videoStream = input(
      'packages/types/src/HostVideo.ts',
      `interface HostVideoCapability {
         attachStream?(stream: unknown): HostImageSource | null;
       }`,
    );
    const surfaceHandle = input('packages/types/src/Surface.ts', 'type NativeSurfaceHandle = unknown;');
    const closed = [
      input(
        'packages/types/src/AppWindow.ts',
        "interface NativeWindowHandle { readonly __brand: 'NativeWindowHandle' }",
      ),
      input(
        'packages/types/src/HostVideo.ts',
        `interface HostVideoStreamHandle { readonly __brand: 'HostVideoStreamHandle' }
         interface HostVideoCapability { attachStream?(stream: HostVideoStreamHandle): HostImageSource | null }`,
      ),
      input(
        'packages/types/src/Surface.ts',
        "interface NativeSurfaceHandle { readonly __brand: 'NativeSurfaceHandle' }",
      ),
    ];
    const controls = [
      input('packages/types/src/Other.ts', 'type NativeWindowHandle = unknown;'),
      input('packages/other/src/AppWindow.ts', 'type NativeWindowHandle = unknown;'),
      input('packages/types/src/AppWindow.ts', 'type NativeWindowHandle = unknown | null;'),
      input('packages/types/src/Surface.ts', 'type NativeSurfaceHandle = any;'),
      input('packages/types/src/Surface.ts', 'type OtherHandle = unknown;'),
      input(
        'packages/types/src/HostVideo.ts',
        'interface HostVideoCapability { attachStream(stream: unknown): HostImageSource | null }',
      ),
      input(
        'packages/types/src/HostVideo.ts',
        'interface HostVideoCapability { attachStream?(stream: unknown): HostImageSource }',
      ),
      input(
        'packages/types/src/HostVideo.ts',
        'interface OtherVideoCapability { attachStream?(stream: unknown): HostImageSource | null }',
      ),
    ];

    const report = analyzeTypeScriptSourcePortability([surfaceHandle, videoStream, windowHandle]);
    expect(report.findings.map(({ subject }) => subject)).toEqual([
      'type:NativeWindowHandle',
      'interface:HostVideoCapability/method:attachStream.parameter:stream',
      'type:NativeSurfaceHandle',
    ]);
    expect(report.findings[0]?.message).toContain('retaining the native object only in provider-private maps');
    expect(report.findings[0]?.message).toContain('genuinely provider-opaque identity boundary');
    expect(report.findings[1]?.message).toContain('only production caller');
    expect(report.findings[1]?.message).toContain("video element's srcObject");
    expect(report.findings[1]?.message).toContain('named closed HostVideoStreamHandle entity');
    expect(report.findings[2]?.message).toContain('only in package-private SurfaceRuntime');
    expect(report.findings[2]?.message).toContain('genuinely provider-opaque');
    for (const finding of report.findings) {
      expect(finding.message).toContain('reviewed source-portability exception for this exact');
      expect(finding.message).toContain('target-specific Any carrier');
      expect(finding.message).toContain('insert a cast');
      expect(finding.message).toMatch(/copy or materialize the (?:native window|live stream|drawable)/u);
    }
    expect(analyzeTypeScriptSourcePortability(closed).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message }) => !message.includes('provider-opaque'),
        ),
      ).toBe(true);
    }

    const reviewed = analyzeTypeScriptSourcePortability([surfaceHandle, videoStream, windowHandle], {
      exceptionPolicy: {
        exceptions: report.findings.map((finding) => ({
          findingIdentity: finding.identity,
          reason: 'The native identity is confined to its provider and never enters portable state or serialization.',
          rule: 'opaque-value-domain' as const,
        })),
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.acceptedExceptions).toHaveLength(3);
  });

  it('requires network JSON responses to use a closed recursive value domain', () => {
    const opaque = input(
      'packages/types/src/Net.ts',
      'type NetResponseBody = string | unknown | ArrayBuffer | Blob | null;',
    );
    const closed = input(
      'packages/types/src/Net.ts',
      `type NetJsonPrimitive = boolean | number | string | null;
       type NetJsonValue =
         | NetJsonPrimitive
         | readonly NetJsonValue[]
         | Readonly<Record<string, NetJsonValue>>;
       type NetResponseBody = string | NetJsonValue | ArrayBuffer | Blob | null;`,
    );
    const controls = [
      input('packages/types/src/Other.ts', 'type NetResponseBody = string | unknown | ArrayBuffer | Blob | null;'),
      input('packages/other/src/Net.ts', 'type NetResponseBody = string | unknown | ArrayBuffer | Blob | null;'),
      input('packages/types/src/Net.ts', 'type NetResponseBody = unknown;'),
      input('packages/types/src/Net.ts', 'type NetResponseBody = string | unknown | ArrayBuffer | null;'),
      input('packages/types/src/Net.ts', 'type NetResponseBody = string | any | ArrayBuffer | Blob | null;'),
      input('packages/types/src/Net.ts', 'type OtherBody = string | unknown | ArrayBuffer | Blob | null;'),
    ];

    const report = analyzeTypeScriptSourcePortability([opaque]);
    expect(report.findings).toMatchObject([{ rule: 'opaque-value-domain', subject: 'type:NetResponseBody' }]);
    const message = report.findings[0]?.message;
    expect(message).toContain('crosses the public NetResponse boundary');
    expect(message).toContain('not a provider token or an unexamined diagnostic');
    expect(message).toContain('JSON.parse or Response.json');
    expect(message).toContain('recursive named closed NetJsonValue domain');
    expect(message).toContain('normalize every host JSON decoder before NetResponse construction');
    expect(message).toContain('will not treat unknown as only JSON');
    expect(message).toContain('target-specific Any carrier');
    expect(message).toContain('insert a cast');
    expect(message).toContain('copy or materialize the response body');
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message }) => !message.includes('NetJsonValue'),
        ),
      ).toBe(true);
    }
  });

  it('requires Aseprite slices to use a closed schema at JSON ingress', () => {
    const opaque = input(
      'packages/types/src/AsepriteSchema.ts',
      `interface AsepriteMeta { slices?: unknown[] }
       interface AsepriteDocument { meta: AsepriteMeta }`,
    );
    const closed = input(
      'packages/types/src/AsepriteSchema.ts',
      `interface AsepriteRect { h: number; w: number; x: number; y: number }
       interface AsepritePoint { x: number; y: number }
       interface AsepriteSliceKey { bounds: AsepriteRect; center?: AsepriteRect; frame: number; pivot?: AsepritePoint }
       interface AsepriteSlice { color?: string; keys: readonly AsepriteSliceKey[]; name: string }
       interface AsepriteMeta { slices?: readonly AsepriteSlice[] }`,
    );
    const controls = [
      input('packages/types/src/Other.ts', 'interface AsepriteMeta { slices?: unknown[] }'),
      input('packages/other/src/AsepriteSchema.ts', 'interface AsepriteMeta { slices?: unknown[] }'),
      input('packages/types/src/AsepriteSchema.ts', 'interface OtherMeta { slices?: unknown[] }'),
      input('packages/types/src/AsepriteSchema.ts', 'interface AsepriteMeta { slices: unknown[] }'),
      input('packages/types/src/AsepriteSchema.ts', 'interface AsepriteMeta { slices?: unknown }'),
      input('packages/types/src/AsepriteSchema.ts', 'interface AsepriteMeta { slices?: any[] }'),
    ];

    const report = analyzeTypeScriptSourcePortability([opaque]);
    expect(report.findings).toMatchObject([
      { rule: 'opaque-value-domain', subject: 'interface:AsepriteMeta/property:slices' },
    ]);
    const message = report.findings[0]?.message;
    expect(message).toContain('exposes the Aseprite JSON slice array through AsepriteDocument');
    expect(message).toContain('parseAsepriteSpritesheetDocument casts JSON.parse directly');
    expect(message).toContain('named closed AsepriteSlice, AsepriteSliceKey, and point schemas');
    expect(message).toContain('validate or normalize the parsed JSON');
    expect(message).toContain('reviewed source-portability exception is justified only if slices are rejected');
    expect(message).toContain('target-specific Any carrier');
    expect(message).toContain('insert a cast');
    expect(message).toContain('copy or materialize the slice payload');
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message: controlMessage }) => !controlMessage.includes('AsepriteSliceKey'),
        ),
      ).toBe(true);
    }
  });

  it('preserves asset cache values as exact adapter-owned resources', () => {
    const opaque = input(
      'packages/types/src/Assets.ts',
      'interface AssetEntry { loadPromise: Promise<unknown> | null; resident: boolean; value: unknown }',
    );
    const closed = input(
      'packages/types/src/Assets.ts',
      'interface AssetEntry<T> { loadPromise: Promise<T> | null; resident: boolean; value: T }',
    );
    const controls = [
      input('packages/types/src/Other.ts', 'interface AssetEntry { value: unknown }'),
      input('packages/other/src/Assets.ts', 'interface AssetEntry { value: unknown }'),
      input('packages/types/src/Assets.ts', 'interface OtherEntry { value: unknown }'),
      input('packages/types/src/Assets.ts', 'interface AssetEntry { value?: unknown }'),
      input('packages/types/src/Assets.ts', 'interface AssetEntry { value: unknown[] }'),
      input('packages/types/src/Assets.ts', 'interface AssetEntry { value: any }'),
    ];

    const report = analyzeTypeScriptSourcePortability([opaque]);
    expect(report.findings.map(({ subject }) => subject)).toEqual(['interface:AssetEntry/property:value']);
    const finding = report.findings[0];
    if (!finding) throw new Error('Expected the AssetEntry value finding');
    expect(finding.message).toContain('AssetLoaderAdapter selected for the entry');
    expect(finding.message).toContain('getAsset returns the resident identity');
    expect(finding.message).toContain('genuinely adapter-owned opaque resource boundary');
    expect(finding.message).toContain('reviewed source-portability exception for this exact property');
    expect(finding.message).toContain('typed per-kind access capabilities');
    expect(finding.message).toContain('target-specific Any carrier');
    expect(finding.message).toContain('insert a cast');
    expect(finding.message).toContain('copy or materialize the decoded resource');
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message }) => !message.includes('adapter-owned opaque resource boundary'),
        ),
      ).toBe(true);
    }

    const reviewed = analyzeTypeScriptSourcePortability([opaque], {
      exceptionPolicy: {
        exceptions: [
          {
            findingIdentity: finding.identity,
            reason: 'The cache returns each decoded resource only to callers and its paired adapter.',
            rule: 'opaque-value-domain',
          },
        ],
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.acceptedExceptions).toMatchObject([{ finding: { identity: finding.identity } }]);
  });

  it('keeps resolved document resources inside the paired open registries', () => {
    const opaque = input(
      'packages/types/src/FlightDocumentNodeSchema.ts',
      'type FlightDocumentResourceLookup = Readonly<Record<string, unknown>>;',
    );
    const closed = input(
      'packages/types/src/FlightDocumentNodeSchema.ts',
      `interface FlightDocumentResourceHandle { readonly kind: string; readonly resourceId: string }
       type FlightDocumentResourceLookup = Readonly<Record<string, FlightDocumentResourceHandle>>;`,
    );
    const controls = [
      input('packages/types/src/Other.ts', 'type FlightDocumentResourceLookup = Readonly<Record<string, unknown>>;'),
      input(
        'packages/other/src/FlightDocumentNodeSchema.ts',
        'type FlightDocumentResourceLookup = Readonly<Record<string, unknown>>;',
      ),
      input('packages/types/src/FlightDocumentNodeSchema.ts', 'type FlightDocumentResourceLookup = unknown;'),
      input(
        'packages/types/src/FlightDocumentNodeSchema.ts',
        'type FlightDocumentResourceLookup = Record<string, unknown>;',
      ),
      input(
        'packages/types/src/FlightDocumentNodeSchema.ts',
        'type FlightDocumentResourceLookup = Readonly<Record<number, unknown>>;',
      ),
      input(
        'packages/types/src/FlightDocumentNodeSchema.ts',
        'type FlightDocumentResourceLookup = Readonly<Record<string, any>>;',
      ),
    ];

    const report = analyzeTypeScriptSourcePortability([opaque]);
    const finding = report.findings[0];
    if (!finding) throw new Error('Expected the FlightDocumentResourceLookup finding');
    expect(finding).toMatchObject({ rule: 'opaque-value-domain', subject: 'type:FlightDocumentResourceLookup' });
    expect(finding.message).toContain('transient identity map between the open resource-resolver registry');
    expect(finding.message).toContain('writers receive an empty lookup');
    expect(finding.message).toContain('genuinely registry-owned opaque resource boundary');
    expect(finding.message).toContain('reviewed source-portability exception for this exact alias');
    expect(finding.message).toContain('named closed tagged FlightDocumentResource handle domain');
    expect(finding.message).toContain('target-specific Any carrier');
    expect(finding.message).toContain('insert a cast');
    expect(finding.message).toContain('copy or materialize a live resource');
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message }) => !message.includes('registry-owned opaque resource boundary'),
        ),
      ).toBe(true);
    }

    const reviewed = analyzeTypeScriptSourcePortability([opaque], {
      exceptionPolicy: {
        exceptions: [
          {
            findingIdentity: finding.identity,
            reason: 'Each node schema alone interprets the live resources created by registered resolvers.',
            rule: 'opaque-value-domain',
          },
        ],
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.acceptedExceptions).toMatchObject([{ finding: { identity: finding.identity } }]);
  });

  it('preserves dialog close values as application-owned signal payloads', () => {
    const opaque = input(
      'packages/types/src/GuiDialog.ts',
      'interface GuiDialogCloseResult { entryId: string; reason: string; value?: unknown }',
    );
    const closed = input(
      'packages/types/src/GuiDialog.ts',
      `type GuiDialogCloseValue = boolean | number | string | null;
       interface GuiDialogCloseResult { entryId: string; reason: string; value?: GuiDialogCloseValue }`,
    );
    const controls = [
      input('packages/types/src/Other.ts', 'interface GuiDialogCloseResult { value?: unknown }'),
      input('packages/other/src/GuiDialog.ts', 'interface GuiDialogCloseResult { value?: unknown }'),
      input('packages/types/src/GuiDialog.ts', 'interface OtherResult { value?: unknown }'),
      input('packages/types/src/GuiDialog.ts', 'interface GuiDialogCloseResult { value: unknown }'),
      input('packages/types/src/GuiDialog.ts', 'interface GuiDialogCloseResult { value?: unknown[] }'),
      input('packages/types/src/GuiDialog.ts', 'interface GuiDialogCloseResult { value?: any }'),
    ];

    const report = analyzeTypeScriptSourcePortability([opaque]);
    const finding = report.findings[0];
    if (!finding) throw new Error('Expected the GuiDialogCloseResult value finding');
    expect(finding).toMatchObject({
      rule: 'opaque-value-domain',
      subject: 'interface:GuiDialogCloseResult/property:value',
    });
    expect(finding.message).toContain('application-owned result of accepting or dismissing a dialog entry');
    expect(finding.message).toContain('emits the same result through onClose');
    expect(finding.message).toContain('genuinely application-opaque result boundary');
    expect(finding.message).toContain('reviewed source-portability exception for this exact property');
    expect(finding.message).toContain('named closed GuiDialogCloseValue domain');
    expect(finding.message).toContain('target-specific Any carrier');
    expect(finding.message).toContain('insert a cast');
    expect(finding.message).toContain('copy or materialize the payload');
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message }) => !message.includes('application-opaque result boundary'),
        ),
      ).toBe(true);
    }

    const reviewed = analyzeTypeScriptSourcePortability([opaque], {
      exceptionPolicy: {
        exceptions: [
          {
            findingIdentity: finding.identity,
            reason: 'The GUI core emits the application payload unchanged and never retains or interprets it.',
            rule: 'opaque-value-domain',
          },
        ],
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.acceptedExceptions).toMatchObject([{ finding: { identity: finding.identity } }]);
  });

  it('keeps the WGPU scene skinning slot on its existing named adapter contract', () => {
    const opaque = input(
      'packages/types/src/WgpuScene3DRuntime.ts',
      'interface WgpuScene3DRuntime { skinningAdapter: unknown | null }',
    );
    const closed = input(
      'packages/types/src/WgpuScene3DRuntime.ts',
      `interface WgpuSkinningAdapter { isGpuSkinned(meshId: number): boolean }
       interface WgpuScene3DRuntime { skinningAdapter: WgpuSkinningAdapter | null }`,
    );
    const controls = [
      input('packages/types/src/Other.ts', 'interface WgpuScene3DRuntime { skinningAdapter: unknown | null }'),
      input(
        'packages/other/src/WgpuScene3DRuntime.ts',
        'interface WgpuScene3DRuntime { skinningAdapter: unknown | null }',
      ),
      input('packages/types/src/WgpuScene3DRuntime.ts', 'interface OtherRuntime { skinningAdapter: unknown | null }'),
      input(
        'packages/types/src/WgpuScene3DRuntime.ts',
        'interface WgpuScene3DRuntime { skinningAdapter?: unknown | null }',
      ),
      input('packages/types/src/WgpuScene3DRuntime.ts', 'interface WgpuScene3DRuntime { skinningAdapter: unknown }'),
      input(
        'packages/types/src/WgpuScene3DRuntime.ts',
        'interface WgpuScene3DRuntime { skinningAdapter: unknown | null | undefined }',
      ),
      input('packages/types/src/WgpuScene3DRuntime.ts', 'interface WgpuScene3DRuntime { skinningAdapter: any | null }'),
      input(
        'packages/types/src/WgpuScene3DRuntime.ts',
        'interface WgpuScene3DRuntime { skinningAdapter: Readonly<unknown> | null }',
      ),
    ];

    const report = analyzeTypeScriptSourcePortability([opaque]);
    expect(report.findings).toMatchObject([
      {
        rule: 'opaque-value-domain',
        subject: 'interface:WgpuScene3DRuntime/property:skinningAdapter',
      },
    ]);
    const message = report.findings[0]?.message;
    expect(message).toContain('erases a contract that is already closed');
    expect(message).toContain('WgpuRenderRegistries.gpuSkinning is a SlotTable<WgpuSkinningAdapter>');
    expect(message).toContain('late registration updates the same slot');
    expect(message).toContain('direct mesh upload, draw, pipeline, and wireframe consumers immediately restore');
    expect(message).toContain('shadow and shader consumers receive that type through the accessor');
    expect(message).toContain('Type the runtime property directly as WgpuSkinningAdapter | null');
    expect(message).toContain('Registry extensibility does not make the adapter opaque');
    expect(message).toContain('A reviewed exception is not justified');
    expect(message).toContain('target-specific Any carrier');
    expect(message).toContain('retain or insert a cast');
    expect(message).toContain('copy or materialize the adapter');
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message: controlMessage }) => !controlMessage.includes('WgpuRenderRegistries.gpuSkinning'),
        ),
      ).toBe(true);
    }
  });

  it('keeps Scene2D materialization dimension probes on the declared node traits contract', () => {
    const opaque = input(
      'packages/scene-document/src/sceneDocumentScene2DMaterialization.ts',
      `declare const Node2DTraitsKey: symbol;
       declare const Node3DTraitsKey: symbol;
       declare function getEntityRuntime(node: object): object;
       function adoptDocumentRoot2D(root: object): boolean {
         const runtime = getEntityRuntime(root) as Readonly<{ traits?: unknown }> | undefined;
         return runtime?.traits === Node2DTraitsKey;
       }
       function checkRootKindDimension(probe: object, dimension: 'Scene2D' | 'Scene3D'): boolean {
         const runtime = getEntityRuntime(probe) as Readonly<{ traits?: unknown }> | undefined;
         const expected = dimension === 'Scene2D' ? Node2DTraitsKey : Node3DTraitsKey;
         return runtime?.traits === expected;
       }`,
    );
    const closed = input(
      'packages/scene-document/src/sceneDocumentScene2DMaterialization.ts',
      `interface NodeAny { readonly id: number }
       declare function hasEntityRuntime(node: NodeAny): boolean;
       declare function isNode2D(node: NodeAny): boolean;
       declare function isNode3D(node: NodeAny): boolean;
       function adoptDocumentRoot2D(root: NodeAny): boolean {
         return hasEntityRuntime(root) && isNode2D(root);
       }
       function checkRootKindDimension(probe: NodeAny, dimension: 'Scene2D' | 'Scene3D'): boolean {
         if (!hasEntityRuntime(probe)) return false;
         return dimension === 'Scene2D' ? isNode2D(probe) : isNode3D(probe);
       }`,
    );
    const controls = [
      input(
        'packages/scene-document/src/OtherMaterialization.ts',
        `function adoptDocumentRoot2D(root: object): void {
           const runtime = root as Readonly<{ traits?: unknown }> | undefined;
           void runtime;
         }`,
      ),
      input(
        'packages/other/src/sceneDocumentScene2DMaterialization.ts',
        `function checkRootKindDimension(root: object): void {
           const runtime = root as Readonly<{ traits?: unknown }> | undefined;
           void runtime;
         }`,
      ),
      input(
        'packages/scene-document/src/sceneDocumentScene2DMaterialization.ts',
        `function otherRootCheck(root: object): void {
           const runtime = root as Readonly<{ traits?: unknown }> | undefined;
           void runtime;
         }`,
      ),
      input(
        'packages/scene-document/src/sceneDocumentScene2DMaterialization.ts',
        `function adoptDocumentRoot2D(root: object): void {
           const nodeRuntime = root as Readonly<{ traits?: unknown }> | undefined;
           void nodeRuntime;
         }`,
      ),
      input(
        'packages/scene-document/src/sceneDocumentScene2DMaterialization.ts',
        `function adoptDocumentRoot2D(root: object): void {
           const runtime = root as Readonly<{ traits: unknown }> | undefined;
           void runtime;
         }`,
      ),
      input(
        'packages/scene-document/src/sceneDocumentScene2DMaterialization.ts',
        `function adoptDocumentRoot2D(root: object): void {
           const runtime = root as Readonly<{ traits?: unknown }>;
           void runtime;
         }`,
      ),
      input(
        'packages/scene-document/src/sceneDocumentScene2DMaterialization.ts',
        `function adoptDocumentRoot2D(root: object): void {
           const runtime = root as Readonly<{ traits?: any }> | undefined;
           void runtime;
         }`,
      ),
    ];

    const report = analyzeTypeScriptSourcePortability([opaque]);
    expect(report.findings.map(({ subject }) => subject)).toEqual([
      'function:adoptDocumentRoot2D/property:traits',
      'function:checkRootKindDimension/property:traits',
    ]);
    expect(report.findings[0]?.message).toContain('after raw document fields and resolved resources');
    expect(report.findings[0]?.message).toContain('typed isNode2D predicate');
    expect(report.findings[0]?.message).toContain('before installing it as the scene root');
    expect(report.findings[1]?.message).toContain('closed Node2DTraitsKey or Node3DTraitsKey identity');
    expect(report.findings[1]?.message).toContain('typed node predicates or getNodeRuntime(probe).traits');
    for (const finding of report.findings) {
      expect(finding.message).toContain('A reviewed exception is not justified');
      expect(finding.message).toContain('target-specific Any carrier');
      expect(finding.message).toContain('preserve or replace the assertion with a cast');
      expect(finding.message).toMatch(/copy or materialize the (?:candidate|probe) node/u);
    }
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message }) => !message.includes('declared Node runtime'),
        ),
      ).toBe(true);
    }
  });

  it('keeps Scene3D materialization dimension probes on the declared node traits contract', () => {
    const opaque = input(
      'packages/scene-document/src/sceneDocumentScene3DMaterialization.ts',
      `declare const Node3DTraitsKey: symbol;
       declare function getEntityRuntime(node: object): object;
       function adoptDocumentRoot3D(root: object): boolean {
         const runtime = getEntityRuntime(root) as Readonly<{ traits?: unknown }> | undefined;
         return runtime?.traits === Node3DTraitsKey;
       }
       function checkRootKindDimension3D(probe: object): boolean {
         const runtime = getEntityRuntime(probe) as Readonly<{ traits?: unknown }> | undefined;
         return runtime?.traits === Node3DTraitsKey;
       }`,
    );
    const closed = input(
      'packages/scene-document/src/sceneDocumentScene3DMaterialization.ts',
      `interface NodeAny { readonly id: number }
       declare function hasEntityRuntime(node: NodeAny): boolean;
       declare function isNode3D(node: NodeAny): boolean;
       function adoptDocumentRoot3D(root: NodeAny): boolean {
         return hasEntityRuntime(root) && isNode3D(root);
       }
       function checkRootKindDimension3D(probe: NodeAny): boolean {
         return hasEntityRuntime(probe) && isNode3D(probe);
       }`,
    );
    const controls = [
      input(
        'packages/scene-document/src/OtherMaterialization.ts',
        `function adoptDocumentRoot3D(root: object): void {
           const runtime = root as Readonly<{ traits?: unknown }> | undefined;
           void runtime;
         }`,
      ),
      input(
        'packages/other/src/sceneDocumentScene3DMaterialization.ts',
        `function checkRootKindDimension3D(root: object): void {
           const runtime = root as Readonly<{ traits?: unknown }> | undefined;
           void runtime;
         }`,
      ),
      input(
        'packages/scene-document/src/sceneDocumentScene3DMaterialization.ts',
        `function otherRootCheck(root: object): void {
           const runtime = root as Readonly<{ traits?: unknown }> | undefined;
           void runtime;
         }`,
      ),
      input(
        'packages/scene-document/src/sceneDocumentScene3DMaterialization.ts',
        `function adoptDocumentRoot3D(root: object): void {
           const nodeRuntime = root as Readonly<{ traits?: unknown }> | undefined;
           void nodeRuntime;
         }`,
      ),
      input(
        'packages/scene-document/src/sceneDocumentScene3DMaterialization.ts',
        `function adoptDocumentRoot3D(root: object): void {
           const runtime = root as Readonly<{ traits: unknown }> | undefined;
           void runtime;
         }`,
      ),
      input(
        'packages/scene-document/src/sceneDocumentScene3DMaterialization.ts',
        `function adoptDocumentRoot3D(root: object): void {
           const runtime = root as Readonly<{ traits?: unknown }>;
           void runtime;
         }`,
      ),
      input(
        'packages/scene-document/src/sceneDocumentScene3DMaterialization.ts',
        `function adoptDocumentRoot3D(root: object): void {
           const runtime = root as Readonly<{ traits?: any }> | undefined;
           void runtime;
         }`,
      ),
    ];

    const report = analyzeTypeScriptSourcePortability([opaque]);
    expect(report.findings.map(({ subject }) => subject)).toEqual([
      'function:adoptDocumentRoot3D/property:traits',
      'function:checkRootKindDimension3D/property:traits',
    ]);
    expect(report.findings[0]?.message).toContain('after raw document fields and resolved resources');
    expect(report.findings[0]?.message).toContain('typed isNode3D predicate');
    expect(report.findings[0]?.message).toContain('before installing it as the scene root');
    expect(report.findings[1]?.message).toContain('closed Node3DTraitsKey identity');
    expect(report.findings[1]?.message).toContain('typed isNode3D predicate backed by getNodeRuntime(probe).traits');
    for (const finding of report.findings) {
      expect(finding.message).toContain('A reviewed exception is not justified');
      expect(finding.message).toContain('target-specific Any carrier');
      expect(finding.message).toContain('preserve or replace the assertion with a cast');
      expect(finding.message).toMatch(/copy or materialize the (?:candidate|probe) node/u);
    }
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message }) => !message.includes('declared Node runtime'),
        ),
      ).toBe(true);
    }
  });

  it('requires tray-style failure results to normalize unknown error payloads at their producer boundary', () => {
    const opaque = input(
      'Tray.ts',
      `export type TrayCreateResult =
         | { readonly outcome: 'created' }
         | { readonly error?: unknown; readonly outcome: 'invalid-icon' }
         | { readonly error?: unknown; readonly outcome: 'tray-create-failed' };
       interface UnrelatedState { readonly payload: unknown }`,
    );
    const closed = input(
      'PortableTray.ts',
      `interface TrayErrorPayload {
         readonly code: string | null;
         readonly message: string;
       }
       export type TrayCreateResult =
         | { readonly outcome: 'created' }
         | { readonly error?: TrayErrorPayload; readonly outcome: 'invalid-icon' }
         | { readonly error?: TrayErrorPayload; readonly outcome: 'tray-create-failed' };`,
    );

    const findings = analyzeTypeScriptSourcePortability([opaque]).findings;
    const errorFindings = findings.filter(({ subject }) => subject.endsWith('/property:error'));
    expect(errorFindings).toHaveLength(2);
    expect(errorFindings.map(({ subject }) => subject)).toEqual([
      'type:TrayCreateResult/arm:outcome=invalid-icon/property:error',
      'type:TrayCreateResult/arm:outcome=tray-create-failed/property:error',
    ]);
    for (const finding of errorFindings) {
      expect(finding).toMatchObject({ rule: 'opaque-value-domain' });
      expect(finding.message).toContain('exposes unknown as an optional error payload');
      expect(finding.message).toContain('JavaScript permits throwing values of any type');
      expect(finding.message).toContain(
        'Normalize every producer at the catch or provider boundary into a named closed error payload',
      );
      expect(finding.message).toContain('record a reviewed source-portability exception');
      expect(finding.message).toContain(
        'will not infer Error, stringify the value, or choose a target-specific Any carrier',
      );
    }
    // The specialized remediation is scoped to the error boundary; other opaque properties retain the
    // general closed-domain guidance, while one named portable payload clears every result arm.
    const unrelated = findings.find(({ subject }) => subject === 'interface:UnrelatedState/property:payload');
    expect(unrelated?.message).toContain('Replace it with a named closed value type');
    expect(unrelated?.message).not.toContain('JavaScript permits throwing values');
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
  });

  it('identifies the exact Tray result errors that preserve genuinely opaque host payloads', () => {
    const opaqueText = `interface TrayDestroyFailure {
         readonly error?: unknown;
         readonly step: 'native-resource';
       }
       type TrayCreateCapabilityResult =
         | { readonly error?: unknown; readonly outcome: 'runtime-api-unavailable' }
         | { readonly error?: unknown; readonly outcome: 'invalid-icon' }
         | { readonly error?: unknown; readonly outcome: 'tray-create-failed' };
       type TrayImageUpdateResult =
         | { readonly error?: unknown; readonly outcome: 'invalid-icon' }
         | { readonly error?: unknown; readonly outcome: 'image-update-failed' };
       type TrayTitleUpdateResult = { readonly error?: unknown; readonly outcome: 'title-update-failed' };
       type TrayTooltipUpdateResult = { readonly error?: unknown; readonly outcome: 'tooltip-update-failed' };
       type TrayTemplateImageUpdateResult = {
         readonly error?: unknown;
         readonly outcome: 'template-image-update-failed';
       };
       type TrayPressedImageUpdateResult =
         | { readonly error?: unknown; readonly outcome: 'invalid-icon' }
         | { readonly error?: unknown; readonly outcome: 'pressed-image-update-failed' };
       type TrayDoubleClickPolicyUpdateResult = {
         readonly error?: unknown;
         readonly outcome: 'double-click-policy-update-failed';
       };
       type TrayMenuUpdateResult =
         | { readonly error?: unknown; readonly outcome: 'menu-build-failed' }
         | { readonly error?: unknown; readonly outcome: 'menu-install-failed' };
       type TrayTitleReadResult = { readonly error?: unknown; readonly outcome: 'title-read-failed' };
       type TrayTooltipReadResult = { readonly error?: unknown; readonly outcome: 'tooltip-read-failed' };
       type TrayBoundsResult = { readonly error?: unknown; readonly outcome: 'bounds-read-failed' };
       type TrayPopupMenuResult = { readonly error?: unknown; readonly outcome: 'popup-failed' };
       type TrayBalloonDisplayResult = { readonly error?: unknown; readonly outcome: 'balloon-display-failed' };
       type TrayBalloonRemoveResult = { readonly error?: unknown; readonly outcome: 'balloon-remove-failed' };
       type TrayReleaseResult = { readonly error?: unknown; readonly outcome: 'release-failed' };
       type TrayEventAttachResult = { readonly error?: unknown; readonly outcome: 'subscription-failed' };`;
    const opaque = input('packages/types/src/Tray.ts', opaqueText);
    const closed = input(
      'packages/types/src/Tray.ts',
      `interface TrayErrorPayload {
         readonly code: string;
         readonly message: string;
         readonly operation: string;
       }
       ${opaqueText.replaceAll('unknown', 'TrayErrorPayload')}`,
    );
    const renamed = input(
      'packages/types/src/Other.ts',
      `type TrayReleaseResult = { readonly error?: unknown; readonly outcome: 'release-failed' };`,
    );
    const sameBasename = input(
      'packages/other/src/Tray.ts',
      `type TrayReleaseResult = { readonly error?: unknown; readonly outcome: 'release-failed' };`,
    );
    const unrelated = input(
      'packages/types/src/Tray.ts',
      `type OtherResult = { readonly error?: unknown; readonly outcome: 'runtime-api-unavailable' };`,
    );
    const anyProbe = input(
      'packages/types/src/Tray.ts',
      `type TrayReleaseResult = { readonly error?: any; readonly outcome: 'release-failed' };`,
    );
    const requiredProbe = input(
      'packages/types/src/Tray.ts',
      `type TrayReleaseResult = { readonly error: unknown; readonly outcome: 'release-failed' };`,
    );
    const nullableProbe = input(
      'packages/types/src/Tray.ts',
      `type TrayReleaseResult = { readonly error?: unknown | null; readonly outcome: 'release-failed' };`,
    );

    const report = analyzeTypeScriptSourcePortability([opaque]);
    const messages = report.findings.map(({ message }) => message);

    expect(report.findings.map(({ subject }) => subject)).toEqual([
      'interface:TrayDestroyFailure/property:error',
      'type:TrayBalloonDisplayResult/arm:outcome=balloon-display-failed/property:error',
      'type:TrayBalloonRemoveResult/arm:outcome=balloon-remove-failed/property:error',
      'type:TrayBoundsResult/arm:outcome=bounds-read-failed/property:error',
      'type:TrayCreateCapabilityResult/arm:outcome=invalid-icon/property:error',
      'type:TrayCreateCapabilityResult/arm:outcome=runtime-api-unavailable/property:error',
      'type:TrayCreateCapabilityResult/arm:outcome=tray-create-failed/property:error',
      'type:TrayDoubleClickPolicyUpdateResult/arm:outcome=double-click-policy-update-failed/property:error',
      'type:TrayEventAttachResult/arm:outcome=subscription-failed/property:error',
      'type:TrayImageUpdateResult/arm:outcome=image-update-failed/property:error',
      'type:TrayImageUpdateResult/arm:outcome=invalid-icon/property:error',
      'type:TrayMenuUpdateResult/arm:outcome=menu-build-failed/property:error',
      'type:TrayMenuUpdateResult/arm:outcome=menu-install-failed/property:error',
      'type:TrayPopupMenuResult/arm:outcome=popup-failed/property:error',
      'type:TrayPressedImageUpdateResult/arm:outcome=invalid-icon/property:error',
      'type:TrayPressedImageUpdateResult/arm:outcome=pressed-image-update-failed/property:error',
      'type:TrayReleaseResult/arm:outcome=release-failed/property:error',
      'type:TrayTemplateImageUpdateResult/arm:outcome=template-image-update-failed/property:error',
      'type:TrayTitleReadResult/arm:outcome=title-read-failed/property:error',
      'type:TrayTitleUpdateResult/arm:outcome=title-update-failed/property:error',
      'type:TrayTooltipReadResult/arm:outcome=tooltip-read-failed/property:error',
      'type:TrayTooltipUpdateResult/arm:outcome=tooltip-update-failed/property:error',
    ]);
    expect(messages.filter((message) => message.includes('reserved capability outcome'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('image decoder failures'))).toHaveLength(3);
    expect(messages.filter((message) => message.includes('lifecycle creation or cancellation cleanup'))).toHaveLength(
      1,
    );
    expect(messages.filter((message) => message.includes('native cleanup failures'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('Native image setters'))).toHaveLength(2);
    expect(
      messages.filter((message) => message.includes('A native setter or the generic update wrapper')),
    ).toHaveLength(4);
    expect(messages.filter((message) => message.includes('menu construction'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('deliberately heterogeneous'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('host read capability or invokeRead'))).toHaveLength(3);
    expect(messages.filter((message) => message.includes('native Tray surface operation'))).toHaveLength(3);
    expect(messages.filter((message) => message.includes('Signal subscription or release'))).toHaveLength(2);
    for (const message of messages) {
      expect(message).toContain('crosses the public Tray result boundary unchanged');
      expect(message).toContain('neither a detection-only probe nor a normalized value: it is genuinely opaque');
      expect(message).toContain('named closed TrayErrorPayload');
      expect(message).toContain('reviewed source-portability exception for this exact property');
      expect(message).toContain('target-specific Any carrier');
      expect(message).toContain('insert a cast');
      expect(message).toContain('copy or materialize the payload');
    }
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const [control, count] of [
      [renamed, 1],
      [sameBasename, 1],
      [unrelated, 1],
      [anyProbe, 1],
      [requiredProbe, 1],
      [nullableProbe, 2],
    ] as const) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(count);
      expect(findings.every((finding) => !finding.message.includes('public Tray result boundary'))).toBe(true);
    }

    const reviewed = analyzeTypeScriptSourcePortability([opaque], {
      exceptionPolicy: {
        exceptions: report.findings.map((finding) => ({
          findingIdentity: finding.identity,
          reason: 'Tray deliberately returns the provider-owned payload only for unexamined host diagnostics.',
          rule: 'opaque-value-domain' as const,
        })),
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.acceptedExceptions).toHaveLength(22);
  });

  it('keeps Tray creation wrapper errors at their proven provider-opaque boundary', () => {
    const opaqueText = `async function createTrayIcon(): Promise<void> {
         const out = allocateEntity<Entity & { error?: unknown; outcome: 'tray-create-failed' }>();
         void out;
       }
       function initializeTrayCreateFailedResult(
         out: EntityConstruction<Entity & { error?: unknown; outcome: 'tray-create-failed' }>,
       ): void { void out; }
       function initializeTrayCreateProviderFailureResult(
         out: EntityConstruction<Entity & { error?: unknown; outcome: string }>,
       ): void { void out; }`;
    const opaque = input('packages/tray/src/tray.ts', opaqueText);
    const closed = input(
      'packages/tray/src/tray.ts',
      `interface TrayErrorPayload { readonly message: string; readonly operation: 'create' }
       ${opaqueText.replaceAll('unknown', 'TrayErrorPayload')}`,
    );
    const controls = [
      input('packages/tray/src/other.ts', opaqueText),
      input('packages/other/src/tray.ts', opaqueText),
      input(
        'packages/tray/src/tray.ts',
        `function other(
           out: EntityConstruction<Entity & { error?: unknown; outcome: 'tray-create-failed' }>,
         ): void { void out; }`,
      ),
      input(
        'packages/tray/src/tray.ts',
        `function initializeTrayCreateFailedResult(
           out: EntityConstruction<Entity & { error?: any; outcome: 'tray-create-failed' }>,
         ): void { void out; }`,
      ),
      input(
        'packages/tray/src/tray.ts',
        `function initializeTrayCreateFailedResult(
           out: EntityConstruction<Entity & { error: unknown; outcome: 'tray-create-failed' }>,
         ): void { void out; }`,
      ),
      input(
        'packages/tray/src/tray.ts',
        `function initializeTrayCreateFailedResult(
           out: EntityConstruction<Entity & { error?: unknown | null; outcome: 'tray-create-failed' }>,
         ): void { void out; }`,
      ),
      input(
        'packages/tray/src/tray.ts',
        `function initializeTrayCreateProviderFailureResult(
           out: EntityConstruction<Entity & { error?: unknown; outcome: number }>,
         ): void { void out; }`,
      ),
      input(
        'packages/tray/src/tray.ts',
        `function initializeTrayCreateProviderFailureResult(
           out: EntityConstruction<Entity & { error?: unknown[]; outcome: string }>,
         ): void { void out; }`,
      ),
    ];

    const report = analyzeTypeScriptSourcePortability([opaque]);
    expect(report.findings.map(({ subject }) => subject)).toEqual([
      'function:createTrayIcon/arm:outcome=tray-create-failed/property:error',
      'function:initializeTrayCreateFailedResult/parameter:out/arm:outcome=tray-create-failed/property:error',
      'function:initializeTrayCreateProviderFailureResult/parameter:out/property:error',
    ]);
    const messages = report.findings.map(({ message }) => message);
    expect(messages.filter((message) => message.includes('catches an arbitrary rejection'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('assigns the catch argument directly'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('non-created host capability result'))).toHaveLength(1);
    for (const message of messages) {
      expect(message).toContain('crosses createTrayIcon unchanged');
      expect(message).toContain('not inspected or serialized');
      expect(message).toContain('not retained in TrayRuntime');
      expect(message).toContain('genuinely provider-opaque');
      expect(message).toContain('named closed TrayErrorPayload');
      expect(message).toContain('reviewed source-portability exception for this exact property');
      expect(message).toContain('target-specific Any carrier');
      expect(message).toContain('insert a cast');
      expect(message).toContain('copy or materialize the payload');
    }
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message }) => !message.includes('genuinely provider-opaque'),
        ),
      ).toBe(true);
    }

    const reviewed = analyzeTypeScriptSourcePortability([opaque], {
      exceptionPolicy: {
        exceptions: report.findings.map((finding) => ({
          findingIdentity: finding.identity,
          reason: 'The wrapper returns provider-owned diagnostics unchanged and never retains or inspects them.',
          rule: 'opaque-value-domain' as const,
        })),
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.acceptedExceptions).toHaveLength(3);
  });

  it('keeps texture-atlas JSON detection probes at a reviewed boundary', () => {
    const opaque = input(
      'packages/textureatlas-formats/src/textureAtlasDetect.ts',
      `function readJsonAtlasKind(): void {
         const obj: { frames?: unknown; meta?: unknown } = {};
         void obj;
       }
       function hasFrameDuration(): void {
         const frame: { duration?: unknown } = {};
         void frame;
       }
       function readMetaApp(): void {
         const meta: { app?: unknown } = {};
         void meta;
       }`,
    );
    const closed = input(
      'packages/textureatlas-formats/src/textureAtlasDetect.ts',
      `interface AtlasFrameProbe { readonly duration?: number }
       interface AtlasMetaProbe { readonly app?: string }
       function readJsonAtlasKind(): void {
         const obj: {
           readonly frames?: readonly AtlasFrameProbe[] | Readonly<Record<string, AtlasFrameProbe>>;
           readonly meta?: AtlasMetaProbe;
         } = {};
         void obj;
       }
       function hasFrameDuration(): void {
         const frame: AtlasFrameProbe = {};
         void frame;
       }
       function readMetaApp(): void {
         const meta: AtlasMetaProbe = {};
         void meta;
       }`,
    );
    const renamed = input(
      'packages/textureatlas-formats/src/otherDetect.ts',
      `function readJsonAtlasKind(): void {
         const obj: { frames?: unknown; meta?: unknown } = {};
         void obj;
       }`,
    );
    const sameBasename = input(
      'packages/other/src/textureAtlasDetect.ts',
      `function readJsonAtlasKind(): void {
         const obj: { frames?: unknown } = {};
         void obj;
       }`,
    );
    const unrelated = input(
      'packages/textureatlas-formats/src/textureAtlasDetect.ts',
      `function inspectExtension(): void {
         const extension: { frames?: unknown } = {};
         void extension;
       }
       function readMetaApp(): void {
         const meta: { vendor?: unknown } = {};
         void meta;
       }`,
    );
    const anyProbe = input(
      'packages/textureatlas-formats/src/textureAtlasDetect.ts',
      `function readMetaApp(): void {
         const meta: { app?: any } = {};
         void meta;
       }`,
    );

    const report = analyzeTypeScriptSourcePortability([opaque]);

    expect(report.findings.map(({ subject }) => subject)).toEqual([
      'function:hasFrameDuration/property:duration',
      'function:readJsonAtlasKind/property:frames',
      'function:readJsonAtlasKind/property:meta',
      'function:readMetaApp/property:app',
    ]);
    expect(report.findings[0]?.message).toContain('Aseprite duration discriminator');
    expect(report.findings[0]?.message).toContain('boolean format evidence');
    expect(report.findings[1]?.message).toContain('parsed-JSON recognition boundary');
    expect(report.findings[1]?.message).toContain('named closed detector document and frame schema');
    expect(report.findings[2]?.message).toContain('guarded app probe');
    expect(report.findings[2]?.message).toContain('named closed detector document and metadata schema');
    expect(report.findings[3]?.message).toContain('format-producer string');
    expect(report.findings[3]?.message).toContain('returns a closed string');
    for (const finding of report.findings) {
      expect(finding.message).toContain('reviewed source-portability exception for this exact property');
      expect(finding.message).toContain('preserve the guards');
      expect(finding.message).toContain('target-specific Any carrier');
      expect(finding.message).toContain('insert a cast');
      expect(finding.message).toContain('copy or materialize the parsed JSON');
    }
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const [control, count] of [
      [renamed, 2],
      [sameBasename, 1],
      [unrelated, 2],
      [anyProbe, 1],
    ] as const) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(count);
      expect(findings.every((finding) => finding.message.includes('Replace it with a named closed value type'))).toBe(
        true,
      );
    }
  });

  it('separates Pixi diagnostic probes from guarded values entering portable config storage', () => {
    const opaque = input(
      'packages/particles-formats/src/pixiParse.ts',
      `type PixiRaw = Record<string, unknown>;
       function collectPixiDiagnostics(): void {
         const accel: { x?: unknown; y?: unknown } | undefined = undefined;
         void accel;
       }
       function rawToConfig(): void {
         const life: { min?: unknown; max?: unknown } | undefined = undefined;
         const colorObj: { start?: unknown; end?: unknown } | undefined = undefined;
         const angleObj: { min?: unknown; max?: unknown } | undefined = undefined;
         const spawnRect: { w?: unknown; h?: unknown } | undefined = undefined;
         const spawnCircle: { r?: unknown } | undefined = undefined;
         void life; void colorObj; void angleObj; void spawnRect; void spawnCircle;
       }
       function readColor(): void {
         const valueObj: { value?: unknown } | null | undefined = undefined;
         void valueObj;
       }
       function readStartEnd(): void {
         const o: { start?: unknown; end?: unknown } = {};
         const startObj: { value?: unknown } | undefined = undefined;
         const endObj: { value?: unknown } | undefined = undefined;
         void o; void startObj; void endObj;
       }`,
    );
    const closed = input(
      'packages/particles-formats/src/pixiParse.ts',
      `interface PixiAccelerationInput { readonly x?: number; readonly y?: number }
       interface PixiRangeWrapper { readonly value?: number }
       type PixiRangeEndpoint = number | PixiRangeWrapper;
       interface PixiRangeInput { readonly end?: PixiRangeEndpoint; readonly start?: PixiRangeEndpoint }
       interface PixiColorWrapper { readonly value?: string }
       type PixiColorEndpoint = string | PixiColorWrapper;
       interface PixiColorInput { readonly end?: PixiColorEndpoint; readonly start?: PixiColorEndpoint }
       interface PixiLifetimeInput { readonly max?: number; readonly min?: number }
       interface PixiAngleInput { readonly max?: number; readonly min?: number }
       interface PixiRectangleInput { readonly h?: number; readonly w?: number }
       interface PixiCircleInput { readonly r?: number }
       interface PixiRaw {
         readonly acceleration?: PixiAccelerationInput;
         readonly alpha?: PixiRangeInput;
         readonly angle?: PixiAngleInput;
         readonly color?: PixiColorInput;
         readonly lifetime?: PixiLifetimeInput;
         readonly scale?: PixiRangeInput;
         readonly spawnCircle?: PixiCircleInput;
         readonly spawnRect?: PixiRectangleInput;
         readonly speed?: PixiRangeInput;
       }
       function collectPixiDiagnostics(): void {
         const accel: PixiAccelerationInput | undefined = undefined;
         void accel;
       }
       function rawToConfig(): void {
         const life: PixiLifetimeInput | undefined = undefined;
         const colorObj: PixiColorInput | undefined = undefined;
         const angleObj: PixiAngleInput | undefined = undefined;
         const spawnRect: PixiRectangleInput | undefined = undefined;
         const spawnCircle: PixiCircleInput | undefined = undefined;
         void life; void colorObj; void angleObj; void spawnRect; void spawnCircle;
       }
       function readColor(): void {
         const valueObj: PixiColorWrapper | null | undefined = undefined;
         void valueObj;
       }
       function readStartEnd(): void {
         const o: PixiRangeInput = {};
         const startObj: PixiRangeWrapper | undefined = undefined;
         const endObj: PixiRangeWrapper | undefined = undefined;
         void o; void startObj; void endObj;
       }`,
    );
    const renamed = input(
      'packages/particles-formats/src/otherParse.ts',
      `type PixiRaw = Record<string, unknown>;
       function collectPixiDiagnostics(): void {
         const accel: { x?: unknown; y?: unknown } | undefined = undefined;
         void accel;
       }`,
    );
    const sameBasename = input('packages/other/src/pixiParse.ts', 'type PixiRaw = Record<string, unknown>;');
    const unrelated = input(
      'packages/particles-formats/src/pixiParse.ts',
      `function rawToConfig(): void {
         const extension: { min?: unknown } = {};
         void extension;
       }`,
    );
    const anyAlias = input('packages/particles-formats/src/pixiParse.ts', 'type PixiRaw = Record<string, any>;');

    const report = analyzeTypeScriptSourcePortability([opaque]);
    const messages = report.findings.map(({ message }) => message);

    expect(report.findings.map(({ subject }) => subject)).toEqual([
      'function:collectPixiDiagnostics/property:x',
      'function:collectPixiDiagnostics/property:y',
      'function:rawToConfig/property:end',
      'function:rawToConfig/property:h',
      'function:rawToConfig/property:max',
      'function:rawToConfig/property:max',
      'function:rawToConfig/property:min',
      'function:rawToConfig/property:min',
      'function:rawToConfig/property:r',
      'function:rawToConfig/property:start',
      'function:rawToConfig/property:w',
      'function:readColor/property:value',
      'function:readStartEnd/property:end',
      'function:readStartEnd/property:start',
      'function:readStartEnd/property:value',
      'function:readStartEnd/property:value',
      'type:PixiRaw',
    ]);
    expect(messages.filter((message) => message.includes('open-key, untrusted Pixi JSON object'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('detection-only acceleration.'))).toHaveLength(2);
    expect(messages.filter((message) => message.includes('portable ParticleEmitterConfig storage'))).toHaveLength(14);
    expect(messages.filter((message) => message.includes('Pixi lifetime.'))).toHaveLength(2);
    expect(messages.filter((message) => message.includes('Pixi angle.'))).toHaveLength(2);
    expect(messages.filter((message) => message.includes('Pixi color.'))).toHaveLength(2);
    expect(messages.filter((message) => message.includes('Pixi spawnRect.'))).toHaveLength(2);
    expect(messages.filter((message) => message.includes('Pixi spawnCircle.r'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('Pixi color start/end wrapper value'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('Pixi start/end range member'))).toHaveLength(2);
    expect(messages.filter((message) => message.includes('nested start wrapper'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('nested end wrapper'))).toHaveLength(1);
    for (const message of messages) {
      expect(message).toContain('reviewed source-portability exception for this exact');
      expect(message).toContain('target-specific Any carrier');
      expect(message).toContain('insert a cast');
      expect(message).toContain('copy or materialize the parsed JSON');
    }
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const [control, count] of [
      [renamed, 3],
      [sameBasename, 1],
      [unrelated, 1],
      [anyAlias, 1],
    ] as const) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(count);
      expect(findings.every((finding) => finding.message.includes('Replace it with a named closed value type'))).toBe(
        true,
      );
    }

    const reviewed = analyzeTypeScriptSourcePortability([opaque], {
      exceptionPolicy: {
        exceptions: report.findings.map((finding) => ({
          findingIdentity: finding.identity,
          reason: 'Pixi JSON is guarded and normalized before any value enters portable asset storage.',
          rule: 'opaque-value-domain' as const,
        })),
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.acceptedExceptions).toHaveLength(17);
  });

  it('keeps Tiled JSON erasure confined behind parser normalization', () => {
    const opaque = input(
      'packages/tilemap-formats/src/tiledJsonParse.ts',
      'type JsonObject = Record<string, unknown>;',
    );
    const closed = input(
      'packages/tilemap-formats/src/tiledJsonParse.ts',
      `type TiledJsonPrimitive = boolean | number | string | null;
       type TiledJsonValue = TiledJsonPrimitive | TiledJsonObject | readonly TiledJsonValue[];
       type TiledJsonObject = Readonly<Record<string, TiledJsonValue>>;`,
    );
    const renamed = input('packages/tilemap-formats/src/otherParse.ts', 'type JsonObject = Record<string, unknown>;');
    const sameBasename = input('packages/other/src/tiledJsonParse.ts', 'type JsonObject = Record<string, unknown>;');
    const unrelated = input(
      'packages/tilemap-formats/src/tiledJsonParse.ts',
      'type ExtensionObject = Record<string, unknown>;',
    );
    const anyRecord = input('packages/tilemap-formats/src/tiledJsonParse.ts', 'type JsonObject = Record<string, any>;');
    const readonlyRecord = input(
      'packages/tilemap-formats/src/tiledJsonParse.ts',
      'type JsonObject = Readonly<Record<string, unknown>>;',
    );

    const report = analyzeTypeScriptSourcePortability([opaque]);
    const finding = report.findings[0];
    if (!finding) throw new Error('Expected an opaque Tiled JSON finding');

    expect(report.findings).toMatchObject([{ rule: 'opaque-value-domain', subject: 'type:JsonObject' }]);
    expect(finding.message).toContain('untrusted Tiled TMJ/TSJ JSON ingress');
    expect(finding.message).toContain('parseJson is the sole producer');
    expect(finding.message).toContain('JSON.parse');
    expect(finding.message).toContain('non-array object');
    expect(finding.message).toContain('layer data becomes a Uint32Array');
    expect(finding.message).toContain('closed TiledProperty scalar domain');
    expect(finding.message).toContain('typed TiledMap and TiledTileset values');
    expect(finding.message).toContain('reviewed source-portability exception for this exact alias');
    expect(finding.message).toContain('recursive named closed TiledJsonValue and TiledJsonObject domains');
    expect(finding.message).toContain('will not assume that unknown contains only JSON values');
    expect(finding.message).toContain('target-specific Any carrier');
    expect(finding.message).toContain('insert a cast');
    expect(finding.message).toContain('copy or materialize the parsed JSON');
    expect(finding.message).toContain('bypass the existing validation path');
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of [renamed, sameBasename, unrelated, anyRecord, readonlyRecord]) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('Replace it with a named closed value type');
    }

    const reviewed = analyzeTypeScriptSourcePortability([opaque], {
      exceptionPolicy: {
        exceptions: [
          {
            findingIdentity: finding.identity,
            reason: 'Tiled JSON members are guarded and normalized before typed asset or diagnostic output.',
            rule: 'opaque-value-domain',
          },
        ],
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.acceptedExceptions).toHaveLength(1);
  });

  it('keeps the Dissolve modifier map probe detection-only behind generic registry dispatch', () => {
    const opaque = input(
      'packages/shading/src/registerBuiltInModifiers.ts',
      `interface Modifier { readonly kind: string }
       const dissolveModifierDefinition = {
         getDefineSignature(modifier: Readonly<Modifier>): string {
           return (modifier as { map?: unknown }).map !== undefined ? 'm' : '';
         },
       };`,
    );
    const closed = input(
      'packages/shading/src/registerBuiltInModifiers.ts',
      `interface Modifier { readonly kind: string }
       interface Texture { readonly id: number }
       interface DissolveModifier extends Modifier {
         readonly kind: 'DissolveModifier';
         readonly map?: Texture;
       }
       interface ModifierDefinition<TModifier extends Modifier> {
         readonly getDefineSignature: (modifier: Readonly<TModifier>) => string;
         readonly kind: TModifier['kind'];
       }
       const dissolveModifierDefinition: ModifierDefinition<DissolveModifier> = {
         kind: 'DissolveModifier',
         getDefineSignature(modifier): string {
           return modifier.map !== undefined ? 'm' : '';
         },
       };`,
    );
    const renamed = input(
      'packages/shading/src/otherBuiltIns.ts',
      `function getDefineSignature(modifier: object): string {
         return (modifier as { map?: unknown }).map !== undefined ? 'm' : '';
       }`,
    );
    const sameBasename = input(
      'packages/other/src/registerBuiltInModifiers.ts',
      `function getDefineSignature(modifier: object): string {
         return (modifier as { map?: unknown }).map !== undefined ? 'm' : '';
       }`,
    );
    const otherFunction = input(
      'packages/shading/src/registerBuiltInModifiers.ts',
      `function inspectModifier(modifier: object): boolean {
         return (modifier as { map?: unknown }).map !== undefined;
       }`,
    );
    const otherProperty = input(
      'packages/shading/src/registerBuiltInModifiers.ts',
      `function getDefineSignature(modifier: object): string {
         return (modifier as { mask?: unknown }).mask !== undefined ? 'm' : '';
       }`,
    );
    const anyProbe = input(
      'packages/shading/src/registerBuiltInModifiers.ts',
      `function getDefineSignature(modifier: object): string {
         return (modifier as { map?: any }).map !== undefined ? 'm' : '';
       }`,
    );
    const retainedUnknown = input(
      'packages/shading/src/registerBuiltInModifiers.ts',
      `function getDefineSignature(): void {
         const modifier: { map?: unknown } = {};
         void modifier;
       }`,
    );

    const report = analyzeTypeScriptSourcePortability([opaque]);
    const finding = report.findings[0];
    if (!finding) throw new Error('Expected an opaque Dissolve modifier map finding');

    expect(report.findings).toMatchObject([
      { rule: 'opaque-value-domain', subject: 'function:getDefineSignature/property:map' },
    ]);
    expect(finding.message).toContain("Dissolve built-in's detection-only map-presence probe");
    expect(finding.message).toContain('registerBuiltInModifiers binds dissolveModifierDefinition');
    expect(finding.message).toContain('getModifierDefineKey resolves that definition with the same base modifier');
    expect(finding.message).toContain('open ModifierRegistry');
    expect(finding.message).toContain("closed 'm' or empty signature");
    expect(finding.message).toContain('reviewed source-portability exception for this exact property');
    expect(finding.message).toContain('kind-coupled');
    expect(finding.message).toContain('validate and recover Readonly<DissolveModifier> before dispatch');
    expect(finding.message).toContain('closed Texture | undefined field');
    expect(finding.message).toContain('A registry tag or key is not that validation');
    expect(finding.message).toContain('target-specific Any carrier');
    expect(finding.message).toContain('retain or insert a cast');
    expect(finding.message).toContain('copy or materialize the modifier or map');
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of [renamed, sameBasename, otherFunction, otherProperty, anyProbe, retainedUnknown]) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('Replace it with a named closed value type');
    }

    const reviewed = analyzeTypeScriptSourcePortability([opaque], {
      exceptionPolicy: {
        exceptions: [
          {
            findingIdentity: finding.identity,
            reason: 'The generic registry callback reduces map presence to a closed signature and never transports it.',
            rule: 'opaque-value-domain',
          },
        ],
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.acceptedExceptions).toHaveLength(1);
  });

  it('requires Spine draw-order JSON to stay behind its storage normalizers', () => {
    const opaque = input(
      'packages/skeleton2d-formats/src/spineParse.ts',
      `function parseSpineDrawOrderTimeline(): void {
         const entry: { offsets?: unknown; time?: unknown } = {};
         void entry;
       }
       function resolveSpineDrawOrder(): void {
         const move: { offset?: unknown; slot?: unknown } = {};
         void move;
       }`,
    );
    const closed = input(
      'packages/skeleton2d-formats/src/spineParse.ts',
      `interface SpineDrawOrderMoveInput { readonly offset?: number; readonly slot?: string }
       interface SpineDrawOrderFrameInput {
         readonly offsets?: readonly SpineDrawOrderMoveInput[];
         readonly time?: number;
       }
       function parseSpineDrawOrderTimeline(): void {
         const entry: SpineDrawOrderFrameInput = {};
         void entry;
       }
       function resolveSpineDrawOrder(): void {
         const move: SpineDrawOrderMoveInput = {};
         void move;
       }`,
    );
    const renamed = input(
      'packages/skeleton2d-formats/src/otherParse.ts',
      `function parseSpineDrawOrderTimeline(): void {
         const entry: { offsets?: unknown; time?: unknown } = {};
         void entry;
       }
       function resolveSpineDrawOrder(): void {
         const move: { offset?: unknown; slot?: unknown } = {};
         void move;
       }`,
    );
    const sameBasename = input(
      'packages/other/src/spineParse.ts',
      `function resolveSpineDrawOrder(): void {
         const move: { offset?: unknown } = {};
         void move;
       }`,
    );
    const unrelated = input(
      'packages/skeleton2d-formats/src/spineParse.ts',
      `function parseSpineDrawOrderTimeline(): void {
         const metadata: { time?: unknown } = {};
         void metadata;
       }`,
    );
    const anyProbe = input(
      'packages/skeleton2d-formats/src/spineParse.ts',
      `function resolveSpineDrawOrder(): void {
         const move: { slot?: any } = {};
         void move;
       }`,
    );

    const report = analyzeTypeScriptSourcePortability([opaque]);
    const messages = report.findings.map(({ message }) => message);

    expect(report.findings.map(({ subject }) => subject)).toEqual([
      'function:parseSpineDrawOrderTimeline/property:offsets',
      'function:parseSpineDrawOrderTimeline/property:time',
      'function:resolveSpineDrawOrder/property:offset',
      'function:resolveSpineDrawOrder/property:slot',
    ]);
    expect(messages.filter((message) => message.includes('Spine draw-order frame offsets'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('Spine draw-order frame time'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('Spine draw-order move offset'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('Spine draw-order move slot'))).toHaveLength(1);
    for (const message of messages) {
      expect(message).toContain('not a detection-only or diagnostic-only probe');
      expect(message).toContain('portable Skeleton2DDrawOrderTimeline storage');
      expect(message).toContain('reviewed source-portability exception for this exact property');
      expect(message).toContain('named closed Spine draw-order');
      expect(message).toContain('target-specific Any carrier');
      expect(message).toContain('insert a cast');
      expect(message).toContain('copy or materialize the parsed JSON');
    }
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const [control, count] of [
      [renamed, 4],
      [sameBasename, 1],
      [unrelated, 1],
      [anyProbe, 1],
    ] as const) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(count);
      expect(findings.every((finding) => finding.message.includes('Replace it with a named closed value type'))).toBe(
        true,
      );
    }

    const reviewed = analyzeTypeScriptSourcePortability([opaque], {
      exceptionPolicy: {
        exceptions: report.findings.map((finding) => ({
          findingIdentity: finding.identity,
          reason: 'Spine draw-order JSON is validated and normalized before timeline storage.',
          rule: 'opaque-value-domain' as const,
        })),
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.acceptedExceptions).toHaveLength(4);
  });

  it('separates closed Lottie sub-schemas from reviewed erased input boundaries', () => {
    const opaque = input(
      'LottieDocument.ts',
      `export interface LottieTextData {
         d: { readonly k: readonly string[] };
         a?: unknown[];
         m?: unknown;
         p?: unknown;
       }
       export interface LottieDocument { chars?: unknown[] }`,
    );
    const closed = input(
      'PortableLottieDocument.ts',
      `interface LottieCharacterShapes { readonly kind: 'shapes'; readonly shapes: readonly string[] }
       interface LottieCharacterPrecomposition { readonly kind: 'precomposition'; readonly refId: string }
       interface LottieCharacterData {
         readonly ch: string;
         readonly data: LottieCharacterPrecomposition | LottieCharacterShapes;
         readonly fFamily: string;
         readonly size: number;
         readonly style: string;
         readonly w: number;
       }
       interface LottieTextRange { readonly name: string; readonly start: number }
       interface LottieTextAlignmentOptions { readonly grouping: 1 | 2 | 3 | 4 }
       interface LottieTextFollowPathOptions { readonly firstMargin: number; readonly lastMargin: number }
       export interface LottieTextData {
         d: { readonly k: readonly string[] };
         a?: LottieTextRange[];
         m?: LottieTextAlignmentOptions;
         p?: LottieTextFollowPathOptions;
       }
       export interface LottieDocument { chars?: LottieCharacterData[] }`,
    );
    const unrelated = input(
      'OtherDocument.ts',
      `interface LottieDocument { chars?: unknown[] }
       interface LottieTextData { a?: unknown[] }`,
    );

    const report = analyzeTypeScriptSourcePortability([opaque]);

    expect(report.findings.map(({ subject }) => subject)).toEqual([
      'interface:LottieDocument/property:chars',
      'interface:LottieTextData/property:a',
      'interface:LottieTextData/property:m',
      'interface:LottieTextData/property:p',
    ]);
    expect(report.findings[0]?.message).toContain('character-data array');
    expect(report.findings[0]?.message).toContain('distinct shapes/precomposition arms');
    expect(report.findings[1]?.message).toContain('text-range array');
    expect(report.findings[2]?.message).toContain('text-alignment options');
    expect(report.findings[3]?.message).toContain('text follow-path options');
    for (const finding of report.findings) {
      expect(finding.message).toContain('reviewed source-portability exception for this exact property');
      expect(finding.message).toContain('outside portable runtime storage');
      expect(finding.message).toContain('target-specific Any carrier');
    }
    expect(report.findings[1]?.message).toContain('will not merge LottieTextData.a, .m, and .p');
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    expect(analyzeTypeScriptSourcePortability([unrelated]).findings).toHaveLength(2);
    expect(
      analyzeTypeScriptSourcePortability([unrelated]).findings.every((finding) =>
        finding.message.includes('Replace it with a named closed value type'),
      ),
    ).toBe(true);

    const reviewed = analyzeTypeScriptSourcePortability([opaque], {
      exceptionPolicy: {
        exceptions: report.findings.map((finding) => ({
          findingIdentity: finding.identity,
          reason: 'Importer retains this unsupported Lottie field only as unexamined input JSON.',
          rule: 'opaque-value-domain' as const,
        })),
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.acceptedExceptions.map(({ finding }) => finding.identity)).toEqual(
      report.findings.map((finding) => finding.identity),
    );
  });

  it('requires a closed handle domain or a reviewed exception for intentional erasure', () => {
    const erased = input('appLoop.ts', 'interface LoopState { frameHandle: unknown }');
    const report = analyzeTypeScriptSourcePortability([erased]);
    const finding = report.findings[0];
    if (!finding) throw new Error('Expected an opaque loop handle finding');
    const closed = input(
      'portable-appLoop.ts',
      `type AppLoopFrameHandle = number;
       interface AppLoopBackend {
         requestFrame(callback: (time: number) => void): AppLoopFrameHandle;
         cancelFrame(handle: AppLoopFrameHandle): void;
       }
       interface LoopState { frameHandle: AppLoopFrameHandle | null }`,
    );

    expect(report.findings).toMatchObject([
      {
        message: expect.stringContaining(
          'Replace it with a named closed value type shared by the boundary, its storage, and its consumers; when intentional erasure is the contract, record a reviewed source-portability exception instead.',
        ),
        rule: 'opaque-value-domain',
        subject: 'interface:LoopState/property:frameHandle',
      },
    ]);
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    expect(
      analyzeTypeScriptSourcePortability([erased], {
        exceptionPolicy: {
          exceptions: [
            {
              findingIdentity: finding.identity,
              reason: 'The handle is an opaque token returned only to its provider.',
              rule: 'opaque-value-domain',
            },
          ],
          schema: 'flight-compiler-source-portability-exceptions/1',
        },
      }),
    ).toMatchObject({
      acceptedExceptions: [{ finding: { identity: finding.identity } }],
      findings: [],
    });
  });

  it('guides optional nullable generic callable owners to one explicit state model', () => {
    const mixed = input(
      'AnimationPlayer.ts',
      `interface AnimationClipEvent { readonly name: string }
       interface Signal<T> { readonly id: number }
       interface AnimationPlayer {
         onEvent?: Signal<(event: Readonly<AnimationClipEvent>) => void> | null;
         onFinished?: Signal<() => void> | null;
         onLooped?: Signal<() => void> | null;
       }`,
    );
    const optional = input(
      'OptionalAnimationPlayer.ts',
      `interface Signal<T> { readonly id: number }
       interface AnimationPlayer { onFinished?: Signal<() => void> }`,
    );
    const nullable = input(
      'NullableAnimationPlayer.ts',
      `interface AnimationClipEvent { readonly name: string }
       interface Signal<T> { readonly id: number }
       interface AnimationPlayer {
         onEvent: Signal<(event: Readonly<AnimationClipEvent>) => void> | null;
         onFinished: Signal<() => void> | null;
         onLooped: Signal<() => void> | null;
       }`,
    );
    const explicit = input(
      'ExplicitAnimationPlayer.ts',
      `interface Signal<T> { readonly id: number }
       type CallbackState =
         | { readonly state: 'unset' }
         | { readonly state: 'disabled' }
         | { readonly signal: Signal<() => void>; readonly state: 'bound' };
       interface AnimationPlayer { onFinished: CallbackState }`,
    );
    const unrelated = input(
      'GenericMixedAbsence.ts',
      'interface Box<T> { value: T } interface Contract { value?: Box<number> | null }',
    );

    // A callback-bearing Signal does not make the two implicit absence spellings one source contract. The
    // measured constructors write null, and every direct use collapses null and undefined with `== null`, so
    // making these properties required-nullable is the exact narrow source fix. The declaration nevertheless
    // exposes three distinguishable states to other consumers until it chooses that one sentinel (or names
    // all three states explicitly), so the gate must not infer the choice from current downstream uses.
    expect(analyzeTypeScriptSourcePortability([mixed]).findings).toMatchObject([
      {
        message: expect.stringContaining(
          'generic callable owner Signal<(event: Readonly<AnimationClipEvent>) => void>',
        ),
        rule: 'mixed-absence',
        subject: 'interface:AnimationPlayer/property:onEvent',
      },
      {
        message: expect.stringContaining('generic callable owner Signal<() => void>'),
        rule: 'mixed-absence',
        subject: 'interface:AnimationPlayer/property:onFinished',
      },
      {
        message: expect.stringContaining('generic callable owner Signal<() => void>'),
        rule: 'mixed-absence',
        subject: 'interface:AnimationPlayer/property:onLooped',
      },
    ]);
    for (const finding of analyzeTypeScriptSourcePortability([mixed]).findings) {
      expect(finding.message).toContain('both an implicit undefined state and an explicit null state');
      expect(finding.message).toContain('present owner retains its exact callable type argument');
      expect(finding.message).toContain('declare the property as a required Signal<');
      expect(finding.message).toContain('initialize it to null in every construction path');
      expect(finding.message).toContain('retain the nullish guard at reads');
      expect(finding.message).toContain('remove null instead');
      expect(finding.message).toContain('named discriminated state');
      expect(finding.message).toContain('will not choose or collapse an absence sentinel');
      expect(finding.message).toContain('allocate or clone a callable owner');
      expect(finding.message).toContain('re-parameterize its callable argument');
      expect(finding.message).toContain('route it through Any');
      expect(finding.message).toContain('reinterpret or cast it');
      expect(finding.message).toContain('or add side storage');
    }
    expect(
      analyzeTypeScriptSourcePortability([optional, nullable, explicit]).findings.filter(
        (finding) => finding.rule === 'mixed-absence',
      ),
    ).toEqual([]);
    expect(analyzeTypeScriptSourcePortability([unrelated]).findings[0]?.message).toBe(
      'interface:Contract/property:value combines an optional property with null; choose one absence representation or make all three states explicit.',
    );
  });

  it('guides optional nullable collection inputs to one absence sentinel without replacing owners', () => {
    const mixed = input(
      'MeshGeometryOptions.ts',
      `interface MeshGeometryFromAttributesOptions {
         indices?: readonly number[] | Uint16Array | Uint32Array | null;
         normals?: readonly number[] | null;
         positions: readonly number[];
         uvs?: readonly number[] | null;
       }
       interface MeshGeometryOptions {
         indices?: Readonly<Uint16Array<ArrayBuffer>> | Readonly<Uint32Array<ArrayBuffer>> | null;
         vertices: Float32Array<ArrayBuffer>;
       }
       function fromAttributes(options: Readonly<MeshGeometryFromAttributesOptions>): void {
         const normals = options.normals ?? null;
         const uvs = options.uvs ?? null;
         if (options.indices) { const src = options.indices; void src.length; }
         void normals;
         void uvs;
       }
       function create(options: Readonly<MeshGeometryOptions>): void {
         if (options.indices) { const indices = options.indices; void indices.length; }
       }`,
    );
    const optional = input(
      'OptionalGeometryOptions.ts',
      'interface GeometryOptions { indices?: readonly number[]; normals?: readonly number[] }',
    );
    const nullable = input(
      'NullableGeometryOptions.ts',
      'interface GeometryOptions { indices: readonly number[] | null; normals: readonly number[] | null }',
    );
    const explicit = input(
      'ExplicitGeometryOptions.ts',
      `type CollectionInput<T> =
         | { readonly state: 'omitted' }
         | { readonly state: 'cleared' }
         | { readonly state: 'supplied'; readonly value: readonly T[] };
       interface GeometryOptions { indices: CollectionInput<number> }`,
    );
    const unrelatedOwner = input('GeometryState.ts', 'interface GeometryState { indices?: readonly number[] | null }');
    const unrelatedValue = input('ScalarOptions.ts', 'interface ScalarOptions { count?: number | null }');
    const findings = analyzeTypeScriptSourcePortability([mixed]).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      {
        rule: 'mixed-absence',
        subject: 'interface:MeshGeometryFromAttributesOptions/property:indices',
      },
      {
        rule: 'mixed-absence',
        subject: 'interface:MeshGeometryFromAttributesOptions/property:normals',
      },
      {
        rule: 'mixed-absence',
        subject: 'interface:MeshGeometryFromAttributesOptions/property:uvs',
      },
      { rule: 'mixed-absence', subject: 'interface:MeshGeometryOptions/property:indices' },
    ]);
    for (const finding of findings) {
      expect(finding.message).toContain('optional collection input');
      expect(finding.message).toContain('both omission and explicit null');
      expect(finding.message).toContain('neither absence state carries elements or a collection owner');
      expect(finding.message).toContain('keep the property optional and remove null');
      expect(finding.message).toContain('retaining each present array or typed-array owner and its element domain');
      expect(finding.message).toContain('normalize once at the consuming boundary');
      expect(finding.message).toContain('name a closed discriminated input state');
      expect(finding.message).toContain('present empty collection is still a supplied value');
      expect(finding.message).toContain('will not choose or collapse an absence sentinel');
      expect(finding.message).toContain('infer an empty collection');
      expect(finding.message).toContain('merge distinct typed-array owners');
      expect(finding.message).toContain('allocate or copy backing storage');
      expect(finding.message).toContain('route elements through Any');
      expect(finding.message).toContain('reinterpret or cast a collection');
      expect(finding.message).toContain('or add side storage');
    }
    expect(
      analyzeTypeScriptSourcePortability([optional, nullable, explicit]).findings.filter(
        (finding) => finding.rule === 'mixed-absence',
      ),
    ).toEqual([]);
    for (const control of [unrelatedOwner, unrelatedValue]) {
      expect(analyzeTypeScriptSourcePortability([control]).findings[0]?.message).toContain(
        'combines an optional property with null; choose one absence representation or make all three states explicit.',
      );
    }
  });

  it('guides paired attachment point storage to required owners or one closed mode', () => {
    const source = input(
      'AttachmentPointStorage.ts',
      `interface Entity { readonly id: number }
       interface Attachment2D extends Entity { kind: string }
       interface Skin2D extends Entity { influenceCounts: Uint16Array; influences: Float32Array }
       interface BoundingBoxAttachment2D extends Attachment2D {
         kind: 'BoundingBoxAttachment2D';
         skin?: Skin2D | null;
         vertices?: Float32Array | null;
       }
       interface ClippingAttachment2D extends Attachment2D {
         kind: 'ClippingAttachment2D';
         skin?: Skin2D | null;
         vertices?: Float32Array | null;
       }
       interface MeshAttachment2D extends Attachment2D {
         skin?: Skin2D | null;
         vertices?: Float32Array | null;
       }
       interface PathAttachment2D extends Attachment2D {
         kind: 'PathAttachment2D';
         skin?: Skin2D | null;
         vertices?: Float32Array | null;
       }
       function initialize(
         out: MeshAttachment2D,
         skin: MeshAttachment2D['skin'],
         vertices: MeshAttachment2D['vertices'],
       ): void {
         out.skin = skin;
         out.vertices = vertices;
       }
       function skinPoints(
         skin: Readonly<Skin2D> | null | undefined,
         vertices: Readonly<Float32Array> | null | undefined,
       ): void {
         if (skin !== null && skin !== undefined) { void skin.influences; return; }
         if (vertices === null || vertices === undefined) return;
         void vertices.length;
       }`,
    );
    const required = input(
      'RequiredAttachmentPointStorage.ts',
      `interface Attachment2D { kind: string }
       interface Skin2D { influences: Float32Array }
       interface MeshAttachment2D extends Attachment2D {
         skin: Skin2D | null;
         vertices: Float32Array | null;
       }`,
    );
    const explicit = input(
      'ExplicitAttachmentPointStorage.ts',
      `interface Skin2D { influences: Float32Array }
       type AttachmentPointStorage =
         | { readonly mode: 'unavailable' }
         | { readonly mode: 'weighted'; readonly skin: Skin2D }
         | { readonly mode: 'rigid'; readonly vertices: Float32Array };
       interface Attachment2D { kind: string; points: AttachmentPointStorage }`,
    );
    const unrelated = input(
      'PointStorage.ts',
      `interface Skin2D { influences: Float32Array }
       interface PointStorage { skin?: Skin2D | null; vertices?: Float32Array | null }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings).toHaveLength(8);
    expect(findings.map((finding) => finding.subject)).toEqual([
      'interface:BoundingBoxAttachment2D/property:skin',
      'interface:BoundingBoxAttachment2D/property:vertices',
      'interface:ClippingAttachment2D/property:skin',
      'interface:ClippingAttachment2D/property:vertices',
      'interface:MeshAttachment2D/property:skin',
      'interface:MeshAttachment2D/property:vertices',
      'interface:PathAttachment2D/property:skin',
      'interface:PathAttachment2D/property:vertices',
    ]);
    for (const finding of findings) {
      expect(finding.rule).toBe('mixed-absence');
      expect(finding.message).toContain("one optional-null half of the attachment's paired point storage");
      expect(finding.message).toContain('Skin2D influences in weighted mode');
      expect(finding.message).toContain('Float32Array of local points in rigid mode');
      expect(finding.message).toContain('rejected or empty input may carry neither');
      expect(finding.message).toContain('Import initializers assign both fields');
      expect(finding.message).toContain('skinSkeleton2DAttachmentPoints treats undefined exactly like null');
      expect(finding.message).toContain('Make both skin and vertices required nullable fields');
      expect(finding.message).toContain('initialize both on every construction path');
      expect(finding.message).toContain('preserving the exact Skin2D and Float32Array owners');
      expect(finding.message).toContain('named closed state whose arms carry those owners explicitly');
      expect(finding.message).toContain('will not infer a mode from whichever optional field happened to be written');
      expect(finding.message).toContain('choose or collapse an absence sentinel');
      expect(finding.message).toContain('reconstruct points from influences');
      expect(finding.message).toContain('allocate or copy either owner');
      expect(finding.message).toContain('route elements through Any');
      expect(finding.message).toContain('reinterpret or cast storage');
      expect(finding.message).toContain('or add side storage');
    }
    expect(analyzeTypeScriptSourcePortability([required, explicit]).findings).toEqual([]);
    const unrelatedFindings = analyzeTypeScriptSourcePortability([unrelated]).findings;
    expect(unrelatedFindings).toHaveLength(2);
    expect(unrelatedFindings.every((finding) => finding.message.includes('combines an optional property'))).toBe(true);
  });

  it('explains the one-sentinel contract for anchor layout constraints', () => {
    const source = input(
      'packages/types/src/Layout.ts',
      `interface AnchorLayoutItemStyle {
         align?: 'bottom' | 'topleft';
         bottom?: number | null;
         height?: number | null;
         left?: number | null;
         right?: number | null;
         top?: number | null;
         width?: number | null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      ['bottom', 'height', 'left', 'right', 'top', 'width'].map((name) => ({
        rule: 'mixed-absence',
        subject: `interface:AnchorLayoutItemStyle/property:${name}`,
      })),
    );
    for (const [index, finding] of findings.entries()) {
      const name = ['bottom', 'height', 'left', 'right', 'top', 'width'][index];
      expect(finding.message).toContain(`gives the anchor constraint ${name} both an omitted state and explicit null`);
      expect(finding.message).toContain('style construction omits inactive constraints');
      expect(finding.message).toContain('isOptionalNumber accepts null and undefined');
      expect(finding.message).toContain('anchorLayoutResolver collapses either');
      expect(finding.message).toContain('opposing-pin stretch, intrinsic-size fallback, or aligned placement');
      expect(finding.message).toContain(
        'Make all six bottom, height, left, right, top, and width constraints optional number fields',
      );
      expect(finding.message).toContain('reserve null for the enclosing itemStyle no-style sentinel');
      expect(finding.message).toContain('name a closed constraint-state union and handle it separately');
      expect(finding.message).toContain('will not preserve a redundant third sentinel in target storage');
      expect(finding.message).toContain('zero is a real pin or size');
      expect(finding.message).toContain('collapse a present value, or add side storage');
    }
  });

  it('keeps unrelated optional-nullable layout properties on the generic mixed-absence guidance', () => {
    const unrelatedOwner = input('OtherLayoutStyle.ts', 'interface OtherLayoutStyle { left?: number | null }');
    const unrelatedMember = input(
      'AnchorLayoutItemStyle.ts',
      'interface AnchorLayoutItemStyle { gap?: number | null }',
    );
    const unrelatedLocation = input(
      'packages/example/src/Layout.ts',
      'interface AnchorLayoutItemStyle { left?: number | null }',
    );
    const findings = analyzeTypeScriptSourcePortability([unrelatedOwner, unrelatedMember, unrelatedLocation]).findings;

    expect(findings).toMatchObject([
      {
        message:
          'interface:AnchorLayoutItemStyle/property:gap combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:AnchorLayoutItemStyle/property:gap',
      },
      {
        message:
          'interface:OtherLayoutStyle/property:left combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:OtherLayoutStyle/property:left',
      },
      {
        message:
          'interface:AnchorLayoutItemStyle/property:left combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:AnchorLayoutItemStyle/property:left',
      },
    ]);
    expect(findings.every((finding) => !finding.message.includes('anchorLayoutResolver'))).toBe(true);
  });

  it('explains the one-sentinel contract for reusable Scene3D render-proxy slots', () => {
    const source = input(
      'packages/types/src/Scene3DRenderProxy.ts',
      `interface ColorScaleBias { readonly redScale: number }
       interface Scene3DRenderProxy {
         alpha?: number;
         colorScaleBias?: Readonly<ColorScaleBias> | null;
         colorMatrix?: readonly number[] | null;
         instanceCount?: number;
         instanceMatrices?: Readonly<Float32Array> | null;
         instanceColors?: Readonly<Float32Array> | null;
         jointMatrices?: Readonly<Float32Array> | null;
         normalMatrices?: Readonly<Float32Array> | null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      ['colorMatrix', 'colorScaleBias', 'instanceColors', 'instanceMatrices', 'jointMatrices', 'normalMatrices'].map(
        (name) => ({
          rule: 'mixed-absence',
          subject: `interface:Scene3DRenderProxy/property:${name}`,
        }),
      ),
    );
    for (const [index, finding] of findings.entries()) {
      const name = [
        'colorMatrix',
        'colorScaleBias',
        'instanceColors',
        'instanceMatrices',
        'jointMatrices',
        'normalMatrices',
      ][index];
      expect(finding.message).toContain(
        `gives the reused per-draw proxy slot ${name} both an omitted state and explicit null`,
      );
      expect(finding.message).toContain('GL and WebGPU producers write null to clear inactive');
      expect(finding.message).toContain('consumers use nullish checks before binding or uploading');
      expect(finding.message).toContain(
        'Make all six colorMatrix, colorScaleBias, instanceColors, instanceMatrices, jointMatrices, and normalMatrices slots required nullable fields',
      );
      expect(finding.message).toContain('initialize them to null, and overwrite or clear them for every draw');
      expect(finding.message).toContain('a reused proxy cannot retain prior-draw state');
      expect(finding.message).toContain('normalize them once at the boundary into that required internal record');
      expect(finding.message).toContain('will not choose between two equivalent absence sentinels');
      expect(finding.message).toContain('infer a palette or color default');
      expect(finding.message).toContain('retain stale state, copy or materialize a buffer, or add side storage');
    }
  });

  it('keeps unrelated optional-nullable render-proxy properties on generic mixed-absence guidance', () => {
    const unrelatedOwner = input(
      'OtherRenderProxy.ts',
      'interface OtherRenderProxy { jointMatrices?: Readonly<Float32Array> | null }',
    );
    const unrelatedMember = input(
      'packages/types/src/Scene3DRenderProxy.ts',
      'interface Scene3DRenderProxy { bounds?: readonly number[] | null }',
    );
    const unrelatedLocation = input(
      'packages/example/src/Scene3DRenderProxy.ts',
      'interface Scene3DRenderProxy { colorMatrix?: readonly number[] | null }',
    );
    const findings = analyzeTypeScriptSourcePortability([unrelatedOwner, unrelatedMember, unrelatedLocation]).findings;

    expect(findings).toMatchObject([
      {
        message:
          'interface:OtherRenderProxy/property:jointMatrices combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:OtherRenderProxy/property:jointMatrices',
      },
      {
        message:
          'interface:Scene3DRenderProxy/property:colorMatrix combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:Scene3DRenderProxy/property:colorMatrix',
      },
      {
        message:
          'interface:Scene3DRenderProxy/property:bounds combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:Scene3DRenderProxy/property:bounds',
      },
    ]);
    expect(findings.every((finding) => !finding.message.includes('reused per-draw proxy slot'))).toBe(true);
  });

  it('explains the one-sentinel contract for mesh deformation slots', () => {
    const source = input(
      'packages/types/src/Mesh.ts',
      `interface Aabb { readonly minX: number }
       interface MeshMorph { readonly weights: Float32Array }
       interface Skin { readonly skeleton: object }
       interface Mesh {
         morph?: MeshMorph | null;
         skin?: Skin | null;
       }
       interface MeshDeformRuntime {
         deformedLocalBounds?: Aabb | null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      {
        rule: 'mixed-absence',
        subject: 'interface:Mesh/property:morph',
      },
      {
        rule: 'mixed-absence',
        subject: 'interface:Mesh/property:skin',
      },
      {
        rule: 'mixed-absence',
        subject: 'interface:MeshDeformRuntime/property:deformedLocalBounds',
      },
    ]);
    for (const [index, finding] of findings.entries()) {
      const name = ['morph', 'skin', 'deformedLocalBounds'][index];
      expect(finding.message).toContain(
        `gives the mesh deformation slot ${name} both an omitted state and explicit null`,
      );
      expect(finding.message).toContain('createMesh leaves morph and skin absent');
      expect(finding.message).toContain('cloneMesh and sceneDocument assign only a present deformer');
      expect(finding.message).toContain('prepareScene3DSkinning creates deformedLocalBounds lazily');
      expect(finding.message).toContain('every direct reader collapses null and undefined');
      expect(finding.message).toContain(
        'Make morph, skin, and deformedLocalBounds optional non-null fields and use omission or undefined as the sole inactive state',
      );
      expect(finding.message).toContain('name a closed deformation-state union and handle both states explicitly');
      expect(finding.message).toContain('will not preserve a redundant null sentinel');
      expect(finding.message).toContain('infer or create a deformer or bounds value');
      expect(finding.message).toContain('rewrite or clone the mesh');
      expect(finding.message).toContain('copy or materialize deformation storage, or add side storage');
    }
  });

  it('keeps unrelated optional-nullable mesh properties on generic mixed-absence guidance', () => {
    const unrelatedOwner = input('OtherMesh.ts', 'interface OtherMesh { skin?: Skin | null }');
    const unrelatedMember = input('packages/types/src/Mesh.ts', 'interface Mesh { bounds?: Aabb | null }');
    const unrelatedLocation = input('packages/example/src/Mesh.ts', 'interface Mesh { morph?: MeshMorph | null }');
    const findings = analyzeTypeScriptSourcePortability([unrelatedOwner, unrelatedMember, unrelatedLocation]).findings;

    expect(findings).toMatchObject([
      {
        message:
          'interface:OtherMesh/property:skin combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:OtherMesh/property:skin',
      },
      {
        message:
          'interface:Mesh/property:morph combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:Mesh/property:morph',
      },
      {
        message:
          'interface:Mesh/property:bounds combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:Mesh/property:bounds',
      },
    ]);
    expect(findings.every((finding) => !finding.message.includes('mesh deformation slot'))).toBe(true);
  });

  it('requires real indexed storage instead of an asserted index-signature view', () => {
    const asserted = input(
      'command.ts',
      `interface NodeAny { readonly enabled: boolean }
       export function readNodeProperty(target: Readonly<NodeAny>, property: string): unknown {
         return (target as unknown as Readonly<Record<string, unknown>>)[property];
       }`,
    );
    const indexed = input(
      'portable-command.ts',
      `type CommandPropertyValue = boolean | number | string | null;
       interface CommandPropertyTarget {
         readonly [property: string]: CommandPropertyValue;
       }
       export function readNodeProperty(
         target: Readonly<CommandPropertyTarget>,
         property: string,
       ): CommandPropertyValue {
         return target[property];
       }`,
    );

    expect(analyzeTypeScriptSourcePortability([asserted]).findings).toMatchObject([
      {
        message:
          'function:readNodeProperty uses a double assertion through unknown to claim an index-signature view; the bridge neither checks that the source has indexed storage nor preserves an exact runtime carrier for computed access. Accept a declared Record or index-signature type at this boundary, or replace the dynamic key with checked access over a closed key/value domain; an assertion cannot create that storage.',
        rule: 'unchecked-double-assertion',
        subject: 'function:readNodeProperty',
      },
    ]);
    expect(analyzeTypeScriptSourcePortability([indexed]).findings).toEqual([]);
  });

  it('requires declared mutable storage for an intentionally open effect domain', () => {
    const asserted = input(
      'effectDefaults.ts',
      `interface Effect { readonly kind: string }
       export function normalizeEffect(effect: Readonly<Effect>, out: Effect): boolean {
         const effectRec = effect as Record<string, unknown>;
         const outRec = out as unknown as Record<string, unknown>;
         for (const key of Object.keys(effectRec)) outRec[key] = effectRec[key];
         return true;
       }`,
    );
    const indexed = input(
      'portable-effectDefaults.ts',
      `interface Effect {
         readonly kind: string;
         [property: string]: unknown;
       }
       export function normalizeEffect(effect: Readonly<Effect>, out: Effect): boolean {
         for (const key of Object.keys(effect)) out[key] = effect[key];
         return true;
       }`,
    );

    expect(analyzeTypeScriptSourcePortability([asserted]).findings).toMatchObject([
      {
        message:
          'function:normalizeEffect uses a double assertion through unknown to claim mutable index-signature storage; the bridge neither proves nor creates writable dynamic cells on the source owner. For an intentionally open key or extension domain, declare a mutable string index signature on the base/output type and construct every value in that carrier; a registry of keys or roles does not recover cells on an owner that lacks them. If the keys are closed, replace the dynamic writes with a finite union of declared members. A reviewed exception can record the source contract but cannot supply that storage; copying or materializing a Record, or adding side storage, would change object identity.',
        rule: 'unchecked-double-assertion',
        subject: 'function:normalizeEffect',
      },
    ]);
    expect(analyzeTypeScriptSourcePortability([indexed]).findings).toEqual([]);
  });

  it('keeps open effect interpolation storage on its base/output carrier', () => {
    const asserted = input(
      'effectInterpolation.ts',
      `interface Effect { readonly kind: string }
       type EffectFieldRole = 'boolean' | 'number';
       type EffectFieldRoles = Readonly<Record<string, Readonly<Record<string, EffectFieldRole>>>>;
       const EFFECT_FIELD_ROLES: EffectFieldRoles = {};
       export function lerpEffect(
         a: Readonly<Effect>,
         b: Readonly<Effect>,
         t: number,
         out: Effect,
         roles: EffectFieldRoles = EFFECT_FIELD_ROLES,
       ): boolean {
         if (a.kind !== b.kind) return false;
         const aRec = a as Record<string, unknown>;
         const bRec = b as Record<string, unknown>;
         const outRecord = out as unknown as Record<string, unknown>;
         for (const key of Object.keys(aRec)) {
           if (roles[a.kind]?.[key] === 'number') outRecord[key] = t;
           else outRecord[key] = bRec[key];
         }
         return true;
       }`,
    );
    const indexed = input(
      'indexed-effectInterpolation.ts',
      `interface Effect {
         readonly kind: string;
         [field: string]: unknown;
       }
       export function lerpEffect(a: Readonly<Effect>, b: Readonly<Effect>, out: Effect): boolean {
         if (a.kind !== b.kind) return false;
         for (const key of Object.keys(a)) out[key] = b[key];
         return true;
       }`,
    );
    const closed = input(
      'closed-effectInterpolation.ts',
      `interface BlurEffect { amount: number; readonly kind: 'blur' }
       interface ToggleEffect { enabled: boolean; readonly kind: 'toggle' }
       type Effect = BlurEffect | ToggleEffect;
       export function lerpEffect(a: Readonly<Effect>, b: Readonly<Effect>, out: Effect): boolean {
         if (a.kind === 'blur' && b.kind === 'blur' && out.kind === 'blur') out.amount = b.amount;
         else if (a.kind === 'toggle' && b.kind === 'toggle' && out.kind === 'toggle') out.enabled = b.enabled;
         else return false;
         return true;
       }`,
    );
    const report = analyzeTypeScriptSourcePortability([asserted]);
    const finding = report.findings[0];
    if (!finding) throw new Error('Expected an effect interpolation assertion finding');

    expect(report.findings).toMatchObject([
      {
        message:
          'function:lerpEffect uses a double assertion through unknown to claim mutable index-signature storage; the bridge neither proves nor creates writable dynamic cells on the source owner. For an intentionally open key or extension domain, declare a mutable string index signature on the base/output type and construct every value in that carrier; a registry of keys or roles does not recover cells on an owner that lacks them. If the keys are closed, replace the dynamic writes with a finite union of declared members. A reviewed exception can record the source contract but cannot supply that storage; copying or materializing a Record, or adding side storage, would change object identity.',
        rule: 'unchecked-double-assertion',
        subject: 'function:lerpEffect',
      },
    ]);
    expect(analyzeTypeScriptSourcePortability([indexed, closed]).findings).toEqual([]);
    expect(
      analyzeTypeScriptSourcePortability([asserted], {
        exceptionPolicy: {
          exceptions: [
            {
              findingIdentity: finding.identity,
              reason: 'Effect kinds and registered field roles are an intentionally open web contract.',
              rule: 'unchecked-double-assertion',
            },
          ],
          schema: 'flight-compiler-source-portability-exceptions/1',
        },
      }),
    ).toMatchObject({
      acceptedExceptions: [{ finding: { identity: finding.identity } }],
      findings: [],
    });
  });

  it('excludes declaration, test-only, and generated inputs before visiting their syntax', () => {
    const text = 'interface Value { payload: any; absent?: string | null }';
    const sources = [
      input('contract.d.ts', text),
      input('contract.test.ts', text),
      input('contract.spec.ts', text),
      input('contract.generated.ts', text),
      input('tests/contract.ts', text),
      input('generated/contract.ts', text),
      input('banner.ts', `// @generated\n${text}`),
    ];

    expect(analyzeTypeScriptSourcePortability(sources)).toEqual({
      acceptedExceptions: [],
      findings: [],
      schema: 'flight-compiler-source-portability/1',
    });
  });

  it('moves caller-owned exception identities out of debt and rejects stale or unexplained records', () => {
    const source = input(
      'value.ts',
      "type Result = { type: 'first'; payload: unknown } | { type: 'second'; payload: unknown };",
    );
    const initial = analyzeTypeScriptSourcePortability([source]);
    const findingIdentity = initial.findings[0]?.identity;
    if (!findingIdentity) throw new Error('Expected an opaque finding');

    expect(initial.findings.map((finding) => finding.subject)).toEqual([
      'type:Result/arm:type=first/property:payload',
      'type:Result/arm:type=second/property:payload',
    ]);
    expect(new Set(initial.findings.map((finding) => finding.identity)).size).toBe(2);

    const accepted = analyzeTypeScriptSourcePortability([source], {
      exceptionPolicy: {
        exceptions: [
          {
            findingIdentity,
            reason: 'The boundary intentionally receives untrusted input.',
            rule: 'opaque-value-domain',
          },
        ],
        schema: 'flight-compiler-source-portability-exceptions/1',
      },
    });

    expect(accepted.findings.map((finding) => finding.subject)).toEqual([
      'type:Result/arm:type=second/property:payload',
    ]);
    expect(accepted.acceptedExceptions).toMatchObject([
      { finding: { identity: findingIdentity }, reason: 'The boundary intentionally receives untrusted input.' },
    ]);
    expect(() =>
      analyzeTypeScriptSourcePortability([source], {
        exceptionPolicy: {
          exceptions: [{ findingIdentity: 'stale', reason: 'Old site.', rule: 'opaque-value-domain' }],
          schema: 'flight-compiler-source-portability-exceptions/1',
        },
      }),
    ).toThrow('Stale source portability exception stale');
    expect(() =>
      analyzeTypeScriptSourcePortability([source], {
        exceptionPolicy: {
          exceptions: [{ findingIdentity, reason: '  ', rule: 'opaque-value-domain' }],
          schema: 'flight-compiler-source-portability-exceptions/1',
        },
      }),
    ).toThrow(`Source portability exception ${findingIdentity} has no reason`);
    expect(() =>
      analyzeTypeScriptSourcePortability([source], {
        exceptionPolicy: {
          exceptions: [
            {
              findingIdentity,
              reason: 'Wrong rule.',
              rule: 'mixed-absence',
            },
          ],
          schema: 'flight-compiler-source-portability-exceptions/1',
        },
      }),
    ).toThrow(`Source portability exception ${findingIdentity} names mixed-absence`);
    expect(() =>
      analyzeTypeScriptSourcePortability([source], {
        exceptionPolicy: {
          exceptions: [
            { findingIdentity, reason: 'Exact intent.', rule: 'opaque-value-domain' },
            { findingIdentity, reason: 'Exact intent.', rule: 'opaque-value-domain' },
          ],
          schema: 'flight-compiler-source-portability-exceptions/1',
        },
      }),
    ).toThrow(`Duplicate source portability exception ${findingIdentity}`);
  });

  it('rejects a source outside the declared upstream checkout', () => {
    expect(() => analyzeTypeScriptSourcePortability([input('../outside.ts', 'const value = 1;')])).toThrow(
      'Source is outside upstream checkout',
    );
  });
});

function input(file: string, text: string): TypeScriptPackageGraphSource {
  const fileName = `/flight/${file}`;
  return {
    packageName: '@flighthq/example',
    packageRoot: '/flight',
    sourceFile: ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true),
    upstreamDirectory: '/flight',
  };
}
