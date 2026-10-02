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

  it('forwards entity guard proxy writes without claiming record storage', () => {
    const declarations = `declare const EntityRuntimeKey: unique symbol;
       interface Entity { [EntityRuntimeKey]: object | undefined }
       interface EntityRuntime { binding: object | null }
       declare function observe(): void;`;
    const source = input(
      'packages/entity/src/guards.ts',
      `${declarations}
       function createGuardedEntity<Type extends object>(entity: Type & Entity): Type & Entity {
         return new Proxy(entity, {
           set(target, prop, value) {
             if (prop === EntityRuntimeKey) observe();
             (target as unknown as Record<PropertyKey, unknown>)[prop] = value;
             return true;
           },
         });
       }
       function createGuardedEntityRuntime(runtime: EntityRuntime): EntityRuntime {
         return new Proxy(runtime, {
           set(target, prop, value) {
             if (prop === 'binding') observe();
             (target as unknown as Record<PropertyKey, unknown>)[prop] = value;
             return true;
           },
         });
       }`,
    );
    const resolved = input(
      'packages/entity/src/guards.ts',
      `${declarations}
       function createGuardedEntity<Type extends object>(entity: Type & Entity): Type & Entity {
         return new Proxy(entity, {
           set(target, prop, value) {
             if (prop === EntityRuntimeKey) observe();
             return Reflect.set(target, prop, value);
           },
         });
       }
       function createGuardedEntityRuntime(runtime: EntityRuntime): EntityRuntime {
         return new Proxy(runtime, {
           set(target, prop, value) {
             if (prop === 'binding') observe();
             return Reflect.set(target, prop, value);
           },
         });
       }`,
    );
    const report = analyzeTypeScriptSourcePortability([source]);

    expect(report.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      {
        rule: 'unchecked-double-assertion',
        subject: 'function:createGuardedEntity/function:set',
      },
      {
        rule: 'unchecked-double-assertion',
        subject: 'function:createGuardedEntityRuntime/function:set',
      },
    ]);
    for (const finding of report.findings) {
      expect(finding.message).toContain("Proxy set trap's PropertyKey and unknown value");
      expect(finding.message).toContain('open interception protocol over a retained typed owner');
      expect(finding.message).toContain('not evidence that the owner is mutable Record<PropertyKey, unknown>');
      expect(finding.message).toContain('erases the declared types of every known cell');
      expect(finding.message).toContain(
        'finite-key rewrite would stop the proxy from forwarding ordinary entity writes',
      );
      expect(finding.message).toContain('Reflect.set(target, prop, value)');
      expect(finding.message).toContain('return its boolean result');
      expect(finding.message).toContain('one named proxy-write forwarder');
      expect(finding.message).toContain('target, key, value, receiver, setter/prototype, and success semantics');
      expect(finding.message).toContain('make that invariant explicit in the forwarder');
      expect(finding.message).toContain('discarding a false result with return true');
      expect(finding.message).toContain('preserve the exact target owner');
      expect(finding.message).toContain('trap ordering');
      expect(finding.message).toContain('forwarded value identity');
      expect(finding.message).toContain('will not reinterpret or cast the owner as a Record');
      expect(finding.message).toContain('route declared cells through Any');
      expect(finding.message).toContain('assume the unknown value satisfies an arbitrary known property');
      expect(finding.message).toContain('copy or materialize the target');
      expect(finding.message).toContain('suppress the forwarding result');
      expect(finding.message).toContain('or add side storage');
    }
    expect(report.findings[0]?.message).toContain('same generic Type & Entity target');
    expect(report.findings[0]?.message).toContain('EntityRuntimeKey runtime slot');
    expect(report.findings[1]?.message).toContain('same EntityRuntime target');
    expect(report.findings[1]?.message).toContain('binding slot');
    expect(analyzeTypeScriptSourcePortability([resolved]).findings).toEqual([]);
  });

  it('keeps entity guard proxy guidance exact to transparent set forwarding', () => {
    const declarations = `declare const EntityRuntimeKey: unique symbol;
       declare const otherProp: PropertyKey;
       declare const otherValue: unknown;
       interface Entity { [EntityRuntimeKey]: object | undefined }
       declare function observe(): void;`;
    const controls = [
      input(
        'packages/example/src/guards.ts',
        `${declarations}
         function createGuardedEntity<Type extends object>(entity: Type & Entity): Type & Entity {
           return new Proxy(entity, { set(target, prop, value) {
             if (prop === EntityRuntimeKey) observe();
             (target as unknown as Record<PropertyKey, unknown>)[prop] = value;
             return true;
           } });
         }`,
      ),
      input(
        'packages/entity/src/guards.ts',
        `${declarations}
         function wrapEntity<Type extends object>(entity: Type & Entity): Type & Entity {
           return new Proxy(entity, { set(target, prop, value) {
             if (prop === EntityRuntimeKey) observe();
             (target as unknown as Record<PropertyKey, unknown>)[prop] = value;
             return true;
           } });
         }`,
      ),
      input(
        'packages/entity/src/guards.ts',
        `${declarations}
         function createGuardedEntity<Type extends object>(entity: Type & Entity): Type & Entity {
           return new Proxy(entity, { set(target, prop, value) {
             if (prop === EntityRuntimeKey) observe();
             (target as unknown as Record<string, unknown>)[prop] = value;
             return true;
           } });
         }`,
      ),
      input(
        'packages/entity/src/guards.ts',
        `${declarations}
         function createGuardedEntity<Type extends object>(entity: Type & Entity): Type & Entity {
           return new Proxy(entity, { set(target, prop, value) {
             if (prop === EntityRuntimeKey) observe();
             (entity as unknown as Record<PropertyKey, unknown>)[prop] = value;
             return true;
           } });
         }`,
      ),
      input(
        'packages/entity/src/guards.ts',
        `${declarations}
         function createGuardedEntity<Type extends object>(entity: Type & Entity): Type & Entity {
           return new Proxy(entity, { set(target, prop, value) {
             if (prop === EntityRuntimeKey) observe();
             (target as unknown as Record<PropertyKey, unknown>)[otherProp] = value;
             return true;
           } });
         }`,
      ),
      input(
        'packages/entity/src/guards.ts',
        `${declarations}
         function createGuardedEntity<Type extends object>(entity: Type & Entity): Type & Entity {
           return new Proxy(entity, { set(target, prop, value) {
             if (prop === EntityRuntimeKey) observe();
             (target as unknown as Record<PropertyKey, unknown>)[prop] = otherValue;
             return true;
           } });
         }`,
      ),
      input(
        'packages/entity/src/guards.ts',
        `${declarations}
         function createGuardedEntity<Type extends object>(entity: Type & Entity): Type & Entity {
           return new Proxy(entity, { set(target, prop, value) {
             if (prop === EntityRuntimeKey) observe();
             (target as unknown as Record<PropertyKey, unknown>)[prop] = value;
             return false;
           } });
         }`,
      ),
      input(
        'packages/entity/src/guards.ts',
        `${declarations}
         function createGuardedEntity<Type extends object>(entity: Type & Entity): Type & Entity {
           return new Proxy(entity, { set(target, prop, value) {
             if (prop === EntityRuntimeKey) observe();
             (target as any as Record<PropertyKey, unknown>)[prop] = value;
             return true;
           } });
         }`,
      ),
      input(
        'packages/entity/src/guards.ts',
        `${declarations}
         function createGuardedEntity<Type extends object>(entity: Type & Entity): Type & Entity {
           return new Proxy(entity, { set(target, prop, value) {
             (target as unknown as Record<PropertyKey, unknown>)[prop] = value;
             return true;
           } });
         }`,
      ),
    ];

    for (const control of controls) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).not.toContain('open interception protocol over a retained typed owner');
      expect(findings[0]?.message).not.toContain('Reflect.set(target, prop, value)');
    }
  });

  it('explains the missing spatial-family proof on node width and height parent lookups', () => {
    const source = input(
      'packages/node/src/boundsRectangle.ts',
      `interface HasBoundsRectangle { readonly bounds: true }
       interface HasTransform2D { readonly x: number; readonly y: number }
       interface Node<Traits extends object> { readonly traits?: Traits }
       type NodeOf<Traits extends object> = Node<Traits> & Traits;
       type Spatial2DNode<Traits extends object> = NodeOf<Traits> & HasBoundsRectangle & HasTransform2D;
       declare const out: object;
       declare function getNodeParent<Traits extends object>(source: Readonly<Node<Traits>>): NodeOf<Traits> | null;
       declare function computeNodeBoundsRectangle<Traits extends object>(
         out: object,
         source: Spatial2DNode<Traits>,
         targetCoordinateSpace: Spatial2DNode<Traits> | null | undefined,
       ): void;
       function getNodeHeight<Traits extends object>(source: Spatial2DNode<Traits>): number {
         computeNodeBoundsRectangle(
           out,
           source,
           getNodeParent(source) as unknown as Spatial2DNode<Traits> | null,
         );
         return 0;
       }
       function getNodeWidth<Traits extends object>(source: Spatial2DNode<Traits>): number {
         computeNodeBoundsRectangle(
           out,
           source,
           getNodeParent(source) as unknown as Spatial2DNode<Traits> | null,
         );
         return 0;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'unchecked-double-assertion', subject: 'function:getNodeHeight' },
      { rule: 'unchecked-double-assertion', subject: 'function:getNodeWidth' },
    ]);
    for (const finding of findings) {
      expect(finding.message).toContain('getNodeParent(source), whose declared result is NodeOf<Traits> | null');
      expect(finding.message).toContain('Spatial2DNode<Traits> bounds and transform capabilities');
      expect(finding.message).toContain("computeNodeBoundsRectangle's target coordinate space");
      expect(finding.message).toContain(
        'Spatial2DNode alias appends HasBoundsRectangle and HasTransform2D outside Traits',
      );
      expect(finding.message).toContain('Traits extends object');
      expect(finding.message).toContain(
        'does not prove that a parent returned by the node runtime owns either capability',
      );
      expect(finding.message).toContain('Put the spatial capabilities inside the family contract');
      expect(finding.message).toContain('constrain Traits to a named HasBoundsRectangle & HasTransform2D base');
      expect(finding.message).toContain('accept the matching NodeOf<Traits> spatial owner');
      expect(finding.message).toContain('pass getNodeParent(source) directly');
      expect(finding.message).toContain('NodeRuntime<Traits>.parent retains that proof');
      expect(finding.message).toContain('typed spatial predicate');
      expect(finding.message).toContain('choose null or another explicit coordinate space');
      expect(finding.message).toContain('preserve the exact parent owner and null sentinel');
      expect(finding.message).toContain('will not infer intersection members that the generic parameter omits');
      expect(finding.message).toContain('reinterpret or cast the parent');
      expect(finding.message).toContain('copy or materialize a replacement node');
      expect(finding.message).toContain('synthesize bounds or transform state');
      expect(finding.message).toContain('or add side storage');
    }
  });

  it('keeps unrelated parent assertions generic and accepts a spatially constrained node family', () => {
    const declarations = `interface HasBoundsRectangle { readonly bounds: true }
       interface HasTransform2D { readonly x: number }
       interface Node<Traits extends object> {}
       type NodeOf<Traits extends object> = Node<Traits> & Traits;
       type Spatial2DNode<Traits extends object> = NodeOf<Traits> & HasBoundsRectangle & HasTransform2D;
       interface OtherTraits { readonly other: true }
       declare const out: object;
       declare const target: Spatial2DNode<object>;
       declare function getNodeParent<Traits extends object>(source: Readonly<Node<Traits>>): NodeOf<Traits> | null;
       declare function getSpatialParent<Traits extends object>(
         source: Spatial2DNode<Traits>,
       ): Spatial2DNode<Traits> | null;
       declare function computeNodeBoundsRectangle<Traits extends object>(
         out: object,
         source: Spatial2DNode<Traits>,
         targetCoordinateSpace: Spatial2DNode<Traits> | null | undefined,
       ): void;`;
    const controls = [
      input(
        'packages/example/src/boundsRectangle.ts',
        `${declarations}
         function getNodeHeight<Traits extends object>(source: Spatial2DNode<Traits>): void {
           computeNodeBoundsRectangle(out, source, getNodeParent(source) as unknown as Spatial2DNode<Traits> | null);
         }`,
      ),
      input(
        'packages/node/src/boundsRectangle.ts',
        `${declarations}
         function getNodeDepth<Traits extends object>(source: Spatial2DNode<Traits>): void {
           computeNodeBoundsRectangle(out, source, getNodeParent(source) as unknown as Spatial2DNode<Traits> | null);
         }`,
      ),
      input(
        'packages/node/src/boundsRectangle.ts',
        `${declarations}
         function getNodeHeight<Traits extends object>(source: Spatial2DNode<Traits>): void {
           computeNodeBoundsRectangle(out, source, getNodeParent(source) as unknown as Spatial2DNode<OtherTraits> | null);
         }`,
      ),
      input(
        'packages/node/src/boundsRectangle.ts',
        `${declarations}
         function getNodeHeight<Traits extends object>(source: Spatial2DNode<Traits>): void {
           computeNodeBoundsRectangle(out, source, getNodeParent(source) as unknown as Spatial2DNode<Traits>);
         }`,
      ),
      input(
        'packages/node/src/boundsRectangle.ts',
        `${declarations}
         function getNodeHeight<Traits extends object>(source: Spatial2DNode<Traits>): void {
           computeNodeBoundsRectangle(out, source, getSpatialParent(source) as unknown as Spatial2DNode<Traits> | null);
         }`,
      ),
      input(
        'packages/node/src/boundsRectangle.ts',
        `${declarations}
         function getNodeHeight<Traits extends object>(source: Spatial2DNode<Traits>): void {
           computeNodeBoundsRectangle(out, source, getNodeParent(target) as unknown as Spatial2DNode<Traits> | null);
         }`,
      ),
      input(
        'packages/node/src/boundsRectangle.ts',
        `${declarations}
         function getNodeHeight<Traits extends object>(source: Spatial2DNode<Traits>): Spatial2DNode<Traits> | null {
           return getNodeParent(source) as unknown as Spatial2DNode<Traits> | null;
         }`,
      ),
      input(
        'packages/node/src/boundsRectangle.ts',
        `${declarations}
         function getNodeHeight<Traits extends object>(source: Spatial2DNode<Traits>): void {
           computeNodeBoundsRectangle(out, source, getNodeParent(source) as any as Spatial2DNode<Traits> | null);
         }`,
      ),
    ];
    const resolved = input(
      'packages/node/src/boundsRectangle.ts',
      `interface HasBoundsRectangle { readonly bounds: true }
       interface HasTransform2D { readonly x: number }
       type SpatialTraits = HasBoundsRectangle & HasTransform2D;
       interface Node<Traits extends object> {}
       type NodeOf<Traits extends object> = Node<Traits> & Traits;
       type Spatial2DNode<Traits extends SpatialTraits> = NodeOf<Traits>;
       declare const out: object;
       declare function getNodeParent<Traits extends object>(source: Readonly<Node<Traits>>): NodeOf<Traits> | null;
       declare function computeNodeBoundsRectangle<Traits extends SpatialTraits>(
         out: object,
         source: Spatial2DNode<Traits>,
         targetCoordinateSpace: Spatial2DNode<Traits> | null | undefined,
       ): void;
       function getNodeHeight<Traits extends SpatialTraits>(source: Spatial2DNode<Traits>): void {
         computeNodeBoundsRectangle(out, source, getNodeParent(source));
       }
       function getNodeWidth<Traits extends SpatialTraits>(source: Spatial2DNode<Traits>): void {
         computeNodeBoundsRectangle(out, source, getNodeParent(source));
       }`,
    );

    expect(analyzeTypeScriptSourcePortability([resolved]).findings).toEqual([]);
    for (const control of controls) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('replace it with a checked conversion or a narrower source type');
      expect(findings[0]?.message).not.toContain('missing spatial-family proof');
      expect(findings[0]?.message).not.toContain('Spatial2DNode alias appends');
    }
  });

  it('explains why the base node runtime factory cannot promise a caller-selected subtype', () => {
    const declarations = `interface NodeRuntime<Traits extends object> { readonly traits?: Traits }
       type NodeRuntimeFactory<Runtime> = (obj?: Readonly<Partial<Runtime>>) => Runtime;
       declare function createNodeRuntime<Traits extends object>(): NodeRuntime<Traits>;`;
    const source = input(
      'packages/node/src/node.ts',
      `${declarations}
       function initializeNode<
         Traits extends object,
         Runtime extends NodeRuntime<Traits>,
       >(createNodeRuntimeFactory?: NodeRuntimeFactory<Runtime>): void {
         const runtimeFactory =
           createNodeRuntimeFactory ?? (createNodeRuntime as unknown as NodeRuntimeFactory<Runtime>);
         void runtimeFactory();
       }`,
    );
    const resolved = input(
      'packages/node/src/node.ts',
      `${declarations}
       function initializeNode<
         Traits extends object,
         Runtime extends NodeRuntime<Traits>,
       >(createNodeRuntimeFactory?: NodeRuntimeFactory<Runtime>): void {
         const runtime =
           createNodeRuntimeFactory !== undefined
             ? createNodeRuntimeFactory()
             : createNodeRuntime<Traits>();
         void runtime;
       }`,
    );
    const report = analyzeTypeScriptSourcePortability([source]);
    const finding = report.findings[0];
    if (!finding) throw new Error('Expected a node runtime factory assertion finding');

    expect(report.findings).toMatchObject([
      {
        rule: 'unchecked-double-assertion',
        subject: 'function:initializeNode',
      },
    ]);
    expect(finding.message).toContain('generic createNodeRuntime fallback as NodeRuntimeFactory<Runtime>');
    expect(finding.message).toContain('Runtime is a caller-selected subtype');
    expect(finding.message).toContain('createNodeRuntime produces the base NodeRuntime<Traits>');
    expect(finding.message).toContain('cannot promise subtype-only fields or initialization');
    expect(finding.message).toContain("factories' distinct optional input contracts");
    expect(finding.message).toContain('initializeNode invokes the selected factory with no argument');
    expect(finding.message).toContain('Branch before the call');
    expect(finding.message).toContain('invoke createNodeRuntimeFactory() when it is present');
    expect(finding.message).toContain('otherwise invoke createNodeRuntime<Traits>()');
    expect(finding.message).toContain('Node<Traits>[EntityRuntimeKey]');
    expect(finding.message).toContain('base slot accepts either result');
    expect(finding.message).toContain('zero-argument NodeRuntimeAllocator<NodeRuntime<Traits>> seam');
    expect(finding.message).toContain('accepts subtype-producing allocators covariantly');
    expect(finding.message).toContain('expose that relation in the constructed node result');
    expect(finding.message).toContain('preserve the exact produced runtime owner');
    expect(finding.message).toContain('will not infer subtype members');
    expect(finding.message).toContain('reinterpret or cast a factory');
    expect(finding.message).toContain('call a factory with a synthetic seed');
    expect(finding.message).toContain('copy or materialize a runtime');
    expect(finding.message).toContain('or add side storage');
    expect(analyzeTypeScriptSourcePortability([resolved]).findings).toEqual([]);
  });

  it('explains why the base Scene2D runtime factory cannot promise a caller-selected subtype', () => {
    const declarations = `interface Node2DRuntime { readonly scene2d: true }
       type NodeRuntimeFactory<Runtime> = (obj?: Readonly<Partial<Runtime>>) => Runtime;
       type Node2DRuntimeFactory<Runtime extends Node2DRuntime> = NodeRuntimeFactory<Runtime>;
       type NodeRuntimeAllocator<Runtime> = () => Runtime;
       declare const out: object;
       declare const kind: string;
       declare const obj: object;
       declare const createData: () => object;
       declare function initializeNode<Runtime extends Node2DRuntime>(
         out: object,
         kind: string,
         obj: object,
         createData: () => object,
         runtimeFactory: NodeRuntimeFactory<Runtime>,
       ): void;
       declare function createNode2DRuntime(): Node2DRuntime;`;
    const source = input(
      'packages/scene2d/src/displayObject.ts',
      `${declarations}
       function createNode2D<R extends Node2DRuntime>(
         createNode2DRuntimeFactory?: Node2DRuntimeFactory<R>,
       ): void {
         initializeNode(
           out,
           kind,
           obj,
           createData,
           createNode2DRuntimeFactory ?? (createNode2DRuntime as unknown as NodeRuntimeFactory<R>),
         );
       }`,
    );
    const resolved = input(
      'packages/scene2d/src/displayObject.ts',
      `${declarations}
       function createNode2D(createNode2DRuntimeFactory?: Node2DRuntimeAllocator): void {
         const runtimeFactory: NodeRuntimeAllocator<Node2DRuntime> =
           createNode2DRuntimeFactory !== undefined
             ? () => createNode2DRuntimeFactory()
             : () => createNode2DRuntime();
         initializeNode(out, kind, obj, createData, runtimeFactory);
       }
       type Node2DRuntimeAllocator = NodeRuntimeAllocator<Node2DRuntime>;`,
    );
    const nodeSource = input(
      'packages/node/src/node.ts',
      `interface NodeRuntime<Traits extends object> { readonly traits?: Traits }
       type NodeRuntimeFactory<Runtime> = (obj?: Readonly<Partial<Runtime>>) => Runtime;
       declare function createNodeRuntime<Traits extends object>(): NodeRuntime<Traits>;
       function initializeNode<Traits extends object, Runtime extends NodeRuntime<Traits>>(
         createNodeRuntimeFactory?: NodeRuntimeFactory<Runtime>,
       ): void {
         const runtimeFactory =
           createNodeRuntimeFactory ?? (createNodeRuntime as unknown as NodeRuntimeFactory<Runtime>);
         void runtimeFactory();
       }`,
    );
    const report = analyzeTypeScriptSourcePortability([source]);
    const finding = report.findings[0];
    if (!finding) throw new Error('Expected a Scene2D runtime factory assertion finding');

    expect(report.findings).toMatchObject([
      {
        rule: 'unchecked-double-assertion',
        subject: 'function:createNode2D',
      },
    ]);
    expect(finding.message).toContain('base createNode2DRuntime fallback as NodeRuntimeFactory<R>');
    expect(finding.message).toContain('R is a caller-selected subtype constrained only by Node2DRuntime');
    expect(finding.message).toContain('createNode2DRuntime produces the base Node2DRuntime');
    expect(finding.message).toContain('cannot promise subtype-only fields or initialization');
    expect(finding.message).toContain("factories' distinct optional input contracts");
    expect(finding.message).toContain('createNode2D forwards the selected factory to initializeNode');
    expect(finding.message).toContain('use () => createNode2DRuntimeFactory() when it is present');
    expect(finding.message).toContain('createNode2DRuntime otherwise');
    expect(finding.message).toContain('pass that exact NodeRuntimeAllocator<Node2DRuntime>');
    expect(finding.message).toContain('createNode2D returns Node2D rather than a result exposing R');
    expect(finding.message).toContain('remove the caller-selected R parameter');
    expect(finding.message).toContain('zero-argument NodeRuntimeAllocator<Node2DRuntime> seam');
    expect(finding.message).toContain('preserve the exact produced runtime owner');
    expect(finding.message).toContain('will not infer subtype members');
    expect(finding.message).toContain('reinterpret or cast a factory');
    expect(finding.message).toContain('call a factory with a synthetic seed');
    expect(finding.message).toContain('copy or materialize a runtime');
    expect(finding.message).toContain('or add side storage');
    expect(analyzeTypeScriptSourcePortability([resolved]).findings).toEqual([]);

    const familyFindings = analyzeTypeScriptSourcePortability([nodeSource, source]).findings;
    expect(familyFindings).toHaveLength(2);
    expect(new Set(familyFindings.map(({ identity }) => identity)).size).toBe(2);
    expect(familyFindings.map(({ subject }) => subject)).toEqual(['function:initializeNode', 'function:createNode2D']);
    expect(familyFindings.every(({ message }) => message.includes('caller-selected subtype'))).toBe(true);
  });

  it('keeps Scene2D runtime factory guidance exact to the initializeNode argument', () => {
    const declarations = `interface Node2DRuntime { readonly scene2d: true }
       interface OtherRuntime extends Node2DRuntime { readonly other: true }
       type NodeRuntimeFactory<Runtime> = (obj?: Readonly<Partial<Runtime>>) => Runtime;
       type Node2DRuntimeFactory<Runtime extends Node2DRuntime> = NodeRuntimeFactory<Runtime>;
       declare const out: object;
       declare const kind: string;
       declare const obj: object;
       declare const createData: () => object;
       declare function createNode2DRuntime(): Node2DRuntime;
       declare function createOtherRuntime(): OtherRuntime;`;
    const controls = [
      input(
        'packages/example/src/displayObject.ts',
        `${declarations}
         function createNode2D<R extends Node2DRuntime>(
           createNode2DRuntimeFactory?: Node2DRuntimeFactory<R>,
         ): void {
           initializeNode(out, kind, obj, createData,
             createNode2DRuntimeFactory ?? (createNode2DRuntime as unknown as NodeRuntimeFactory<R>));
         }`,
      ),
      input(
        'packages/scene2d/src/displayObject.ts',
        `${declarations}
         function createOther2D<R extends Node2DRuntime>(
           createNode2DRuntimeFactory?: Node2DRuntimeFactory<R>,
         ): void {
           initializeNode(out, kind, obj, createData,
             createNode2DRuntimeFactory ?? (createNode2DRuntime as unknown as NodeRuntimeFactory<R>));
         }`,
      ),
      input(
        'packages/scene2d/src/displayObject.ts',
        `${declarations}
         function createNode2D<R extends Node2DRuntime>(
           createNode2DRuntimeFactory?: Node2DRuntimeFactory<R>,
         ): void {
           initializeNode(out, kind, obj, createData,
             createNode2DRuntimeFactory ??
               (createNode2DRuntime as unknown as NodeRuntimeFactory<Node2DRuntime>));
         }`,
      ),
      input(
        'packages/scene2d/src/displayObject.ts',
        `${declarations}
         function createNode2D<R extends Node2DRuntime>(
           createNode2DRuntimeFactory?: Node2DRuntimeFactory<R>,
         ): void {
           initializeNode(out, kind, obj, createData,
             createNode2DRuntimeFactory ?? (createOtherRuntime as unknown as NodeRuntimeFactory<R>));
         }`,
      ),
      input(
        'packages/scene2d/src/displayObject.ts',
        `${declarations}
         function createNode2D<R extends Node2DRuntime>(
           fallbackFactory?: Node2DRuntimeFactory<R>,
         ): void {
           initializeNode(out, kind, obj, createData,
             fallbackFactory ?? (createNode2DRuntime as unknown as NodeRuntimeFactory<R>));
         }`,
      ),
      input(
        'packages/scene2d/src/displayObject.ts',
        `${declarations}
         function createNode2D<R extends Node2DRuntime>(
           createNode2DRuntimeFactory?: Node2DRuntimeFactory<R>,
         ): void {
           createNode(out, kind, obj, createData,
             createNode2DRuntimeFactory ?? (createNode2DRuntime as unknown as NodeRuntimeFactory<R>));
         }`,
      ),
      input(
        'packages/scene2d/src/displayObject.ts',
        `${declarations}
         function createNode2D<R extends Node2DRuntime>(
           createNode2DRuntimeFactory?: Node2DRuntimeFactory<R>,
         ): void {
           initializeNode(out, kind, obj,
             createNode2DRuntimeFactory ?? (createNode2DRuntime as unknown as NodeRuntimeFactory<R>));
         }`,
      ),
      input(
        'packages/scene2d/src/displayObject.ts',
        `${declarations}
         function createNode2D<R extends Node2DRuntime>(
           createNode2DRuntimeFactory?: Node2DRuntimeFactory<R>,
         ): void {
           const runtimeFactory =
             createNode2DRuntimeFactory ?? (createNode2DRuntime as unknown as NodeRuntimeFactory<R>);
           initializeNode(out, kind, obj, createData, runtimeFactory);
         }`,
      ),
      input(
        'packages/scene2d/src/displayObject.ts',
        `${declarations}
         function createNode2D<R extends Node2DRuntime>(
           createNode2DRuntimeFactory?: Node2DRuntimeFactory<R>,
         ): void {
           initializeNode(out, kind, obj, createData,
             createNode2DRuntimeFactory ?? (createNode2DRuntime as any as NodeRuntimeFactory<R>));
         }`,
      ),
    ];

    for (const control of controls) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('replace it with a checked conversion or a narrower source type');
      expect(findings[0]?.message).not.toContain('caller-selected subtype');
      expect(findings[0]?.message).not.toContain('NodeRuntimeAllocator');
    }
  });

  it('keeps node runtime factory guidance exact to the generic fallback selection', () => {
    const declarations = `interface NodeRuntime<Traits extends object> { readonly traits?: Traits }
       interface OtherRuntime<Traits extends object> extends NodeRuntime<Traits> { readonly other: true }
       type NodeRuntimeFactory<Runtime> = (obj?: Readonly<Partial<Runtime>>) => Runtime;
       declare function createNodeRuntime<Traits extends object>(): NodeRuntime<Traits>;
       declare function createOtherRuntime<Traits extends object>(): OtherRuntime<Traits>;`;
    const controls = [
      input(
        'packages/example/src/node.ts',
        `${declarations}
         function initializeNode<Traits extends object, Runtime extends NodeRuntime<Traits>>(
           createNodeRuntimeFactory?: NodeRuntimeFactory<Runtime>,
         ): void {
           const runtimeFactory =
             createNodeRuntimeFactory ?? (createNodeRuntime as unknown as NodeRuntimeFactory<Runtime>);
           void runtimeFactory();
         }`,
      ),
      input(
        'packages/node/src/node.ts',
        `${declarations}
         function initializeOtherNode<Traits extends object, Runtime extends NodeRuntime<Traits>>(
           createNodeRuntimeFactory?: NodeRuntimeFactory<Runtime>,
         ): void {
           const runtimeFactory =
             createNodeRuntimeFactory ?? (createNodeRuntime as unknown as NodeRuntimeFactory<Runtime>);
           void runtimeFactory();
         }`,
      ),
      input(
        'packages/node/src/node.ts',
        `${declarations}
         function initializeNode<Traits extends object, Runtime extends NodeRuntime<Traits>>(
           createNodeRuntimeFactory?: NodeRuntimeFactory<Runtime>,
         ): void {
           const runtimeFactory =
             createNodeRuntimeFactory ?? (createNodeRuntime as unknown as NodeRuntimeFactory<OtherRuntime<Traits>>);
           void runtimeFactory();
         }`,
      ),
      input(
        'packages/node/src/node.ts',
        `${declarations}
         function initializeNode<Traits extends object, Runtime extends NodeRuntime<Traits>>(
           createNodeRuntimeFactory?: NodeRuntimeFactory<Runtime>,
         ): void {
           const runtimeFactory =
             createNodeRuntimeFactory ?? (createOtherRuntime as unknown as NodeRuntimeFactory<Runtime>);
           void runtimeFactory();
         }`,
      ),
      input(
        'packages/node/src/node.ts',
        `${declarations}
         function initializeNode<Traits extends object, Runtime extends NodeRuntime<Traits>>(
           fallbackFactory?: NodeRuntimeFactory<Runtime>,
         ): void {
           const runtimeFactory = fallbackFactory ?? (createNodeRuntime as unknown as NodeRuntimeFactory<Runtime>);
           void runtimeFactory();
         }`,
      ),
      input(
        'packages/node/src/node.ts',
        `${declarations}
         function initializeNode<Traits extends object, Runtime extends NodeRuntime<Traits>>(
           createNodeRuntimeFactory?: NodeRuntimeFactory<Runtime>,
         ): void {
           const selectedFactory =
             createNodeRuntimeFactory ?? (createNodeRuntime as unknown as NodeRuntimeFactory<Runtime>);
           void selectedFactory();
         }`,
      ),
      input(
        'packages/node/src/node.ts',
        `${declarations}
         function initializeNode<Traits extends object, Runtime extends NodeRuntime<Traits>>(
           createNodeRuntimeFactory?: NodeRuntimeFactory<Runtime>,
         ): NodeRuntimeFactory<Runtime> {
           return createNodeRuntime as unknown as NodeRuntimeFactory<Runtime>;
         }`,
      ),
      input(
        'packages/node/src/node.ts',
        `${declarations}
         function initializeNode<Traits extends object, Runtime extends NodeRuntime<Traits>>(
           createNodeRuntimeFactory?: NodeRuntimeFactory<Runtime>,
         ): void {
           const runtimeFactory =
             createNodeRuntimeFactory ?? (createNodeRuntime as any as NodeRuntimeFactory<Runtime>);
           void runtimeFactory();
         }`,
      ),
    ];

    for (const control of controls) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('replace it with a checked conversion or a narrower source type');
      expect(findings[0]?.message).not.toContain('caller-selected subtype');
      expect(findings[0]?.message).not.toContain('NodeRuntimeAllocator');
    }
  });

  it('keeps cube texture face clones and writes on an exact six-slot carrier', () => {
    const declarations = `interface TextureSource { readonly width: number }
       type TextureSourceCubeFaces = readonly [
         TextureSource | null,
         TextureSource | null,
         TextureSource | null,
         TextureSource | null,
         TextureSource | null,
         TextureSource | null
       ];`;
    const texture = input(
      'packages/texture/src/texture.ts',
      `${declarations}
       interface TextureLike { readonly sources: TextureSourceCubeFaces }
       interface CreateTextureOptions { readonly sources?: TextureSourceCubeFaces }
       export function cloneTexture(source: Readonly<TextureLike>): TextureSourceCubeFaces {
         return source.sources.slice() as unknown as TextureSourceCubeFaces;
       }
       export function copyTexture(source: Readonly<TextureLike>): TextureSourceCubeFaces {
         return source.sources.slice() as unknown as TextureSourceCubeFaces;
       }
       export function createTexture(opts: Readonly<CreateTextureOptions>): TextureSourceCubeFaces {
         return (opts.sources?.slice() ?? [null, null, null, null, null, null]) as unknown as TextureSourceCubeFaces;
       }`,
    );
    const cubeTexture = input(
      'packages/texture/src/cubeTexture.ts',
      `${declarations}
       export function setCubeTextureFace(
         sources: TextureSourceCubeFaces,
         faceIndex: number,
         source: TextureSource | null,
       ): void {
         (sources as unknown as (TextureSource | null)[])[faceIndex] = source;
       }`,
    );
    const report = analyzeTypeScriptSourcePortability([texture, cubeTexture]);

    expect(report.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'unchecked-double-assertion', subject: 'function:setCubeTextureFace' },
      { rule: 'unchecked-double-assertion', subject: 'function:cloneTexture' },
      { rule: 'unchecked-double-assertion', subject: 'function:copyTexture' },
      { rule: 'unchecked-double-assertion', subject: 'function:createTexture' },
    ]);
    for (const subject of ['function:cloneTexture', 'function:copyTexture']) {
      const finding = report.findings.find((candidate) => candidate.subject === subject);
      expect(finding?.message).toContain('source.sources.slice()');
      expect(finding?.message).toContain('fixed six-slot TextureSourceCubeFaces carrier');
      expect(finding?.message).toContain('+X, -X, +Y, -Y, +Z, and -Z extent');
      expect(finding?.message).toContain('explicit six-element tuple');
      expect(finding?.message).toContain('named cloneTextureSourceCubeFaces helper');
      expect(finding?.message).toContain('retaining every TextureSource identity and null sentinel');
      expect(finding?.message).toContain('will not infer tuple length from slice');
      expect(finding?.message).toContain('copy or materialize a TextureSource owner');
      expect(finding?.message).toContain('side storage');
    }
    const create = report.findings.find(({ subject }) => subject === 'function:createTexture');
    expect(create?.message).toContain('opts.sources?.slice() ?? [null, null, null, null, null, null]');
    expect(create?.message).toContain('fallback literal has the required extent');
    expect(create?.message).toContain('optional chaining plus slice widens the combined expression');
    expect(create?.message).toContain('Branch once');
    expect(create?.message).toContain('canonical face order');
    expect(create?.message).toContain('will not infer tuple length across slice and ??');
    expect(create?.message).toContain('replace a supplied face list with the fallback');
    const set = report.findings.find(({ subject }) => subject === 'function:setCubeTextureFace');
    expect(set?.message).toContain('exact readonly six-slot TextureSourceCubeFaces carrier sources');
    expect(set?.message).toContain('mutable unbounded (TextureSource | null)[]');
    expect(set?.message).toContain('grants writability and discards the fixed extent');
    expect(set?.message).toContain('Give CubeTexture a named mutable six-slot face-storage carrier');
    expect(set?.message).toContain('0 | 1 | 2 | 3 | 4 | 5');
    expect(set?.message).toContain('update the selected slot on that same storage owner');
    expect(set?.message).toContain('will not cast away readonly');
    expect(set?.message).toContain('accept an out-of-range index');
  });

  it('keeps cube texture tuple guidance exact to its source expressions', () => {
    const declarations = `interface TextureSource { readonly width: number }
       type TextureSourceCubeFaces = readonly [
         TextureSource | null,
         TextureSource | null,
         TextureSource | null,
         TextureSource | null,
         TextureSource | null,
         TextureSource | null
       ];`;
    const portable = input(
      'packages/texture/src/texture.ts',
      `${declarations}
       type MutableTextureSourceCubeFaces = [
         TextureSource | null,
         TextureSource | null,
         TextureSource | null,
         TextureSource | null,
         TextureSource | null,
         TextureSource | null
       ];
       function cloneTextureSourceCubeFaces(source: TextureSourceCubeFaces): MutableTextureSourceCubeFaces {
         return [source[0], source[1], source[2], source[3], source[4], source[5]];
       }
       export function cloneTexture(source: { sources: TextureSourceCubeFaces }): TextureSourceCubeFaces {
         return cloneTextureSourceCubeFaces(source.sources);
       }
       export function setCubeTextureFace(
         sources: MutableTextureSourceCubeFaces,
         faceIndex: 0 | 1 | 2 | 3 | 4 | 5,
         source: TextureSource | null,
       ): void {
         sources[faceIndex] = source;
       }`,
    );
    const controls = [
      input(
        'packages/example/src/texture.ts',
        `${declarations}
         function cloneTexture(source: { sources: TextureSourceCubeFaces }): TextureSourceCubeFaces {
           return source.sources.slice() as unknown as TextureSourceCubeFaces;
         }`,
      ),
      input(
        'packages/texture/src/texture.ts',
        `${declarations}
         function cloneOther(source: { sources: TextureSourceCubeFaces }): TextureSourceCubeFaces {
           return source.sources.slice() as unknown as TextureSourceCubeFaces;
         }`,
      ),
      input(
        'packages/texture/src/texture.ts',
        `${declarations}
         function cloneTexture(source: { faces: TextureSourceCubeFaces }): TextureSourceCubeFaces {
           return source.faces.slice() as unknown as TextureSourceCubeFaces;
         }`,
      ),
      input(
        'packages/texture/src/texture.ts',
        `${declarations}
         function copyTexture(source: { sources: TextureSourceCubeFaces }): TextureSourceCubeFaces {
           return source.sources.slice(0) as unknown as TextureSourceCubeFaces;
         }`,
      ),
      input(
        'packages/texture/src/texture.ts',
        `${declarations}
         function createTexture(opts: { sources?: TextureSourceCubeFaces }): TextureSourceCubeFaces {
           return (opts.sources?.slice() ?? [null, null, null, null, null]) as unknown as TextureSourceCubeFaces;
         }`,
      ),
      input(
        'packages/texture/src/cubeTexture.ts',
        `${declarations}
         function setCubeTextureFace(
           faces: TextureSourceCubeFaces,
           faceIndex: number,
           source: TextureSource | null,
         ): void {
           (faces as unknown as (TextureSource | null)[])[faceIndex] = source;
         }`,
      ),
      input(
        'packages/texture/src/cubeTexture.ts',
        `${declarations}
         function setCubeTextureFace(
           sources: TextureSourceCubeFaces,
           slot: number,
           source: TextureSource | null,
         ): void {
           (sources as unknown as (TextureSource | null)[])[slot] = source;
         }`,
      ),
    ];

    expect(analyzeTypeScriptSourcePortability([portable]).findings).toEqual([]);
    for (const control of controls) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('replace it with a checked conversion or a narrower source type');
      expect(findings[0]?.message).not.toContain('six-slot TextureSourceCubeFaces');
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

  it('traces the Flight signal scope owner widening to its bulk-disconnect contract', () => {
    const connection = input(
      'packages/signals/src/connection.ts',
      `export function connectSignalTracked<T extends (...args: any[]) => void>(
         signal: Signal<T>,
         slot: T,
         options?: Readonly<SignalTrackedConnectOptions>,
       ): SignalConnection<T> {
         const connection: SignalConnection<T> = { connected: true, paused: false, signal, slot };
         options?.scope?.connections.push(
           connection as unknown as SignalConnection<(...args: any[]) => void>,
         );
         return connection;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([connection]).findings;

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: 'unchecked-double-assertion',
      subject: 'function:connectSignalTracked',
    });
    expect(findings[0]?.message).toContain(
      'push the represented SignalConnection<T> owner into SignalScope.connections',
    );
    expect(findings[0]?.message).toContain('current bulk-disconnect scope contract');
    expect(findings[0]?.message).toContain('named zero-argument disconnect operation');
    expect(findings[0]?.message).toContain('calls disconnectSignalConnection(connection)');
    expect(findings[0]?.message).toContain('have disconnectSignalScope drain and invoke those operations');
    expect(findings[0]?.message).toContain('preserve connection as SignalConnection<T>');
    expect(findings[0]?.message).toContain('explicit type-erased handle and target-runtime contract');
    expect(findings[0]?.message).toContain('will not treat type-parameter variance as representation equivalence');
    expect(findings[0]?.message).toContain('reinterpret or cast the owner');
    expect(findings[0]?.message).toContain('copy or materialize a replacement');
    expect(findings[0]?.message).toContain('or add side storage');
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
    expect(message).toContain('initializes skinningAdapter to null');
    expect(message).toContain('registerWgpuGpuSkinning is the sole non-null producer');
    expect(message).toContain('module-level WGPU_SKINNING_ADAPTER singleton');
    expect(message).toContain('No path clears or substitutes another value');
    expect(message).toContain(
      'plus four direct mesh-upload, mesh-selection, draw-bind-group, and pipeline-layout reads',
    );
    expect(message).toContain('Classic, PBR, Shaded, Toon, and Unlit shader construction plus both shadow paths');
    expect(message).toContain('Type the runtime property directly as WgpuSkinningAdapter | null');
    expect(message).toContain('remove all five casts while preserving the null checks and owner identity');
    expect(message).toContain('adjacent shaded-material cache values are genuinely backend-private unknowns');
    expect(message).toContain('WgpuSkinningAdapter is already a public closed interface in @flighthq/types');
    expect(message).toContain('nullable interface reference without an Any carrier');
    expect(message).toContain('A reviewed exception is not justified');
    expect(message).toContain('target-specific Any carrier');
    expect(message).toContain('retain or insert a cast');
    expect(message).toContain('infer or install a skinning adapter');
    expect(message).toContain('invoke an adapter method');
    expect(message).toContain('copy or materialize the adapter');
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    for (const control of controls) {
      expect(
        analyzeTypeScriptSourcePortability([control]).findings.every(
          ({ message: controlMessage }) =>
            !controlMessage.includes('registerWgpuGpuSkinning is the sole non-null producer'),
        ),
      ).toBe(true);
    }
  });

  it('resolves exactly the three current WGPU Scene3D runtime findings', () => {
    const current = input(
      'packages/types/src/WgpuScene3DRuntime.ts',
      `interface WgpuScene3DRuntime {
         customShaderGuard?: ((shaderKey: string) => void) | null;
         forwardLightSelectionGuard?: ((lights: Readonly<object>) => void) | null;
         skinningAdapter: unknown | null;
       }`,
    );
    const resolved = input(
      'packages/types/src/WgpuScene3DRuntime.ts',
      `interface WgpuSkinningAdapter { isGpuSkinned(mesh: object): boolean }
       interface WgpuScene3DRuntime {
         customShaderGuard: ((shaderKey: string) => void) | null;
         forwardLightSelectionGuard: ((lights: Readonly<object>) => void) | null;
         skinningAdapter: WgpuSkinningAdapter | null;
       }`,
    );

    const report = analyzeTypeScriptSourcePortability([current]);
    expect(report.findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      {
        rule: 'mixed-absence',
        subject: 'interface:WgpuScene3DRuntime/property:customShaderGuard',
      },
      {
        rule: 'mixed-absence',
        subject: 'interface:WgpuScene3DRuntime/property:forwardLightSelectionGuard',
      },
      {
        rule: 'opaque-value-domain',
        subject: 'interface:WgpuScene3DRuntime/property:skinningAdapter',
      },
    ]);
    expect(report.acceptedExceptions).toEqual([]);
    expect(analyzeTypeScriptSourcePortability([resolved]).findings).toEqual([]);
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
       ${opaqueText.replaceAll('error?: unknown', 'error: TrayErrorPayload | null')}`,
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
      expect(message).toContain('construct an own error property even when JavaScript throws null or undefined');
      expect(message).toContain('only permits a host-authored failure to omit a diagnostic');
      expect(message).toContain("createTrayIcon checks that distinction with 'error' in result");
      expect(message).toContain('none observes own-property presence');
      expect(message).toContain('do not form distinct public states');
      expect(message).toContain('crosses the public Tray result boundary unchanged');
      expect(message).toContain('neither a detection-only probe nor a normalized value: it is genuinely opaque');
      expect(message).toContain('named closed TrayErrorPayload');
      expect(message).toContain('required TrayErrorPayload | null');
      expect(message).toContain('make error required unknown');
      expect(message).toContain('reviewed source-portability exception for this exact property');
      expect(message).toContain('can lower the current guarded presence test and exact value forwarding');
      expect(message).toContain('target-specific Any carrier');
      expect(message).toContain('insert a cast');
      expect(message).toContain('collapse or invent an absence sentinel');
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
      expect(findings.every((finding) => !finding.message.includes('none observes own-property presence'))).toBe(true);
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
    const projected = input(
      'ProjectedLottieDocument.ts',
      `export interface LottieTextData { d: { readonly k: readonly string[] } }
       export interface LottieDocument { readonly layers: readonly string[] }`,
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
    expect(report.findings[0]?.message).toContain('parseLottieDocument only passes JSON through');
    expect(report.findings[0]?.message).toContain('current importer never reads document.chars');
    expect(report.findings[0]?.message).toContain('presence and omission have the same imported result');
    expect(report.findings[0]?.message).toContain('Remove chars from the portable LottieDocument projection');
    expect(report.findings[0]?.message).toContain('distinct shapes/precomposition arms');
    expect(report.findings[1]?.message).toContain('text-range array');
    expect(report.findings[2]?.message).toContain('text-alignment options');
    expect(report.findings[3]?.message).toContain('text follow-path options');
    for (const [index, property] of ['a', 'm', 'p'].entries()) {
      const message = report.findings[index + 1]?.message;
      expect(message).toContain('appendLottieText reads only LottieTextData.d.k[0].s');
      expect(message).toContain(`never reads ${property}`);
      expect(message).toContain('presence and omission have the same imported result');
      expect(message).toContain(`Remove ${property} from the portable LottieTextData projection`);
    }
    for (const finding of report.findings) {
      expect(finding.message).toContain('reviewed source-portability exception for this exact property');
      expect(finding.message).toContain('outside portable runtime storage');
      expect(finding.message).toContain('target-specific Any carrier');
    }
    expect(report.findings[1]?.message).toContain('will not merge LottieTextData.a, .m, and .p');
    expect(analyzeTypeScriptSourcePortability([closed]).findings).toEqual([]);
    expect(analyzeTypeScriptSourcePortability([projected]).findings).toEqual([]);
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

  it('explains one-sentinel parser codec inputs at the exact AWD2 and SWF normalization boundaries', () => {
    const capabilityDeclarations = `interface HostDecompressDeflateCapability {
         decompress(source: Uint8Array): Uint8Array | null;
       }
       interface HostDecompressLzmaCapability {
         decompress(source: Uint8Array): Uint8Array | null;
       }`;
    const sources = [
      input(
        'packages/types/src/Awd2ParseOptions.ts',
        `${capabilityDeclarations}
         interface Awd2ParseOptions {
           readonly blocks: readonly number[];
           readonly deflate?: Readonly<HostDecompressDeflateCapability> | null;
           readonly lzma?: Readonly<HostDecompressLzmaCapability> | null;
         }
         declare function rehydrateAwd2Body(
           input: Uint8Array,
           deflate: Readonly<HostDecompressDeflateCapability> | null,
           lzma: Readonly<HostDecompressLzmaCapability> | null,
           diagnostics: string[] | undefined,
         ): Uint8Array | null;
         function parseAwd2(
           input: Uint8Array,
           options: Readonly<Awd2ParseOptions>,
           diagnostics: string[] | undefined,
         ): Uint8Array | null {
           return rehydrateAwd2Body(input, options.deflate ?? null, options.lzma ?? null, diagnostics);
         }`,
      ),
      input(
        'packages/types/src/SwfParseOptions.ts',
        `${capabilityDeclarations}
         interface SwfParseOptions {
           readonly deflate?: Readonly<HostDecompressDeflateCapability> | null;
           readonly lzma?: Readonly<HostDecompressLzmaCapability> | null;
           readonly tags: readonly number[];
         }
         declare function uncompressSwfSource(
           source: Uint8Array,
           deflate: Readonly<HostDecompressDeflateCapability> | null,
           lzma: Readonly<HostDecompressLzmaCapability> | null,
           diagnostics: string[] | undefined,
         ): Uint8Array | null;
         function readSwfFile(
           source: Uint8Array,
           options: Readonly<SwfParseOptions>,
           diagnostics: string[] | undefined,
         ): Uint8Array | null {
           return uncompressSwfSource(source, options.deflate ?? null, options.lzma ?? null, diagnostics);
         }`,
      ),
    ];
    const findings = analyzeTypeScriptSourcePortability(sources).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'mixed-absence', subject: 'interface:Awd2ParseOptions/property:deflate' },
      { rule: 'mixed-absence', subject: 'interface:Awd2ParseOptions/property:lzma' },
      { rule: 'mixed-absence', subject: 'interface:SwfParseOptions/property:deflate' },
      { rule: 'mixed-absence', subject: 'interface:SwfParseOptions/property:lzma' },
    ]);
    for (const finding of findings) {
      expect(finding.message).toContain('parser codec capability');
      expect(finding.message).toContain('both omission and explicit null');
      expect(finding.message).toContain(
        'rehydrateAwd2Body(input, options.deflate ?? null, options.lzma ?? null, diagnostics)',
      );
      expect(finding.message).toContain(
        'uncompressSwfSource(source, options.deflate ?? null, options.lzma ?? null, diagnostics)',
      );
      expect(finding.message).toContain('required Readonly<HostDecompressDeflateCapability> | null');
      expect(finding.message).toContain('Readonly<HostDecompressLzmaCapability> | null');
      expect(finding.message).toContain('same unavailable-codec state');
      expect(finding.message).toContain('present capability owner passes unchanged');
      expect(finding.message).toContain('invoked only for its matching compression kind');
      expect(finding.message).toContain('deflate?: Readonly<HostDecompressDeflateCapability>');
      expect(finding.message).toContain('lzma?: Readonly<HostDecompressLzmaCapability>');
      expect(finding.message).toContain('retain the ?? null normalization');
      expect(finding.message).toContain('keep the required-nullable downstream parameters');
      expect(finding.message).toContain('named closed codec-input state');
      expect(finding.message).toContain('will not choose or collapse an absence sentinel');
      expect(finding.message).toContain('infer a codec from the file header');
      expect(finding.message).toContain('invoke a decompressor');
      expect(finding.message).toContain('report or suppress an unread-input diagnostic');
      expect(finding.message).toContain('replace or copy a capability owner');
      expect(finding.message).toContain('route decompressed bytes through Any');
      expect(finding.message).toContain('reinterpret or cast a capability');
      expect(finding.message).toContain('or add side storage');
    }
  });

  it('keeps unrelated or structurally different parser codec options on generic guidance', () => {
    const declarations = `interface HostDecompressDeflateCapability { readonly kind: 'deflate' }
       interface HostDecompressLzmaCapability { readonly kind: 'lzma' }`;
    const controls = [
      input(
        'packages/types/src/Awd2ParseOptions.ts',
        `${declarations}
         interface Awd2ParseOptions { deflate?: Readonly<HostDecompressDeflateCapability> | null }`,
      ),
      input(
        'packages/types/src/SwfParseOptions.ts',
        `${declarations}
         interface SwfParseOptions {
           deflate?: HostDecompressDeflateCapability | null;
           lzma?: HostDecompressLzmaCapability | null;
         }`,
      ),
      input(
        'packages/types/src/Awd2ParseOptions.ts',
        `${declarations}
         interface OtherParseOptions {
           deflate?: Readonly<HostDecompressDeflateCapability> | null;
           lzma?: Readonly<HostDecompressLzmaCapability> | null;
         }`,
      ),
      input(
        'packages/example/src/SwfParseOptions.ts',
        `${declarations}
         interface SwfParseOptions {
           deflate?: Readonly<HostDecompressDeflateCapability> | null;
           lzma?: Readonly<HostDecompressLzmaCapability> | null;
         }`,
      ),
      input(
        'packages/types/src/Awd2ParseOptions.ts',
        `${declarations}
         interface Awd2ParseOptions {
           inflate?: Readonly<HostDecompressDeflateCapability> | null;
           lzma?: Readonly<HostDecompressLzmaCapability> | null;
         }`,
      ),
    ];
    for (const control of controls) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((finding) => finding.message.includes('combines an optional property with null'))).toBe(
        true,
      );
      expect(findings.every((finding) => !finding.message.includes('parser codec capability'))).toBe(true);
    }

    const resolved = [
      input(
        'packages/types/src/Awd2ParseOptions.ts',
        `${declarations}
         interface Awd2ParseOptions {
           deflate?: Readonly<HostDecompressDeflateCapability>;
           lzma?: Readonly<HostDecompressLzmaCapability>;
         }`,
      ),
      input(
        'packages/types/src/SwfParseOptions.ts',
        `${declarations}
         interface SwfParseOptions {
           deflate: Readonly<HostDecompressDeflateCapability> | null;
           lzma: Readonly<HostDecompressLzmaCapability> | null;
         }`,
      ),
    ];
    expect(analyzeTypeScriptSourcePortability(resolved).findings).toEqual([]);
  });

  it('traces the three AnimationPlayer signal slots to one explicit disabled state', () => {
    const mixed = input(
      'packages/types/src/AnimationPlayer.ts',
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
    const sameShapeElsewhere = input(
      'packages/example/src/AnimationPlayer.ts',
      `interface Signal<T> { readonly id: number }
       interface AnimationPlayer { onFinished?: Signal<() => void> | null }`,
    );

    // Both library construction paths write null, the opt-in enabler replaces either nullish spelling with the
    // exact Signal owner, and every emitter collapses null and undefined. That makes required-nullable the exact
    // source remedy. The target still preserves the authored states until the declaration chooses that sentinel.
    const findings = analyzeTypeScriptSourcePortability([mixed]).findings;
    expect(findings).toMatchObject([
      {
        rule: 'mixed-absence',
        subject: 'interface:AnimationPlayer/property:onEvent',
      },
      {
        rule: 'mixed-absence',
        subject: 'interface:AnimationPlayer/property:onFinished',
      },
      {
        rule: 'mixed-absence',
        subject: 'interface:AnimationPlayer/property:onLooped',
      },
    ]);
    const exactFlows = [
      ['onEvent', 'emits only the clip markers crossed in that segment'],
      ['onFinished', 'a finite repeat budget is exhausted'],
      ['onLooped', 'at least one permitted repeat wrap or ping-pong bounce'],
    ] as const;
    for (const [index, finding] of findings.entries()) {
      const [field, flow] = exactFlows[index]!;
      expect(finding.message).toContain(`opt-in AnimationPlayer signal ${field}`);
      expect(finding.message).toContain('both omission and explicit null');
      expect(finding.message).toContain('one signal-free state');
      expect(finding.message).toContain(
        'cloneAnimationPlayer and initializeAnimationPlayer assign onEvent, onFinished, and onLooped to null',
      );
      expect(finding.message).toContain('createAnimationPlayer delegates to that initializer');
      expect(finding.message).toContain('enableAnimationPlayerSignals checks each slot with == null');
      expect(finding.message).toContain('is idempotent, and no path clears an enabled slot');
      expect(finding.message).toContain(flow);
      expect(finding.message).toContain(
        'Make all three slots required fields with their exact callable-bearing Signal type | null',
      );
      expect(finding.message).toContain('retain the explicit null assignments in the clone and initializer');
      expect(finding.message).toContain('Null initialization remains allocation-free');
      expect(finding.message).toContain('C++ backend can already preserve the current null and undefined tags');
      expect(finding.message).toContain("does not choose the source contract's redundant disabled sentinel");
      expect(finding.message).toContain('external compatibility input');
      expect(finding.message).toContain('one named closed signal state');
      expect(finding.message).toContain('will not choose or collapse an absence sentinel');
      expect(finding.message).toContain('allocate or clone a Signal owner');
      expect(finding.message).toContain('connect or emit a listener');
      expect(finding.message).toContain('re-parameterize the callback');
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
    const [other] = analyzeTypeScriptSourcePortability([sameShapeElsewhere]).findings;
    expect(other?.message).toContain('generic callable owner Signal<() => void>');
    expect(other?.message).not.toContain('enableAnimationPlayerSignals');
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

  it('explains the one not-supplied state for mesh geometry attribute construction inputs', () => {
    const source = input(
      'packages/types/src/MeshGeometryFromAttributesOptions.ts',
      `export interface MeshGeometryFromAttributesOptions {
         indices?: readonly number[] | Uint16Array | Uint32Array | null;
         normals?: readonly number[] | null;
         positions: readonly number[];
         uvs?: readonly number[] | null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;
    const fields = ['indices', 'normals', 'uvs'];

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      fields.map((field) => ({
        rule: 'mixed-absence',
        subject: `interface:MeshGeometryFromAttributesOptions/property:${field}`,
      })),
    );
    for (const [index, finding] of findings.entries()) {
      const field = fields[index];
      expect(finding.message).toContain(
        `construction-only mesh attribute input ${field} both omission and explicit null`,
      );
      expect(finding.message).toContain('createMeshGeometryFromAttributes has one not-supplied state');
      expect(finding.message).toContain('It is the sole production consumer');
      expect(finding.message).toContain('normalizes normals and uvs with ?? null and tests indices by truthiness');
      expect(finding.message).toContain('null and undefined take the same path');
      expect(finding.message).toContain(
        'Repository call sites either omit each optional field or supply its collection',
      );
      expect(finding.message).toContain('has no update or clear operation for explicit null to express');
      expect(finding.message).toContain(
        'Make indices optional readonly number[] | Uint16Array | Uint32Array and make normals and uvs optional readonly number[]',
      );
      expect(finding.message).toContain('removing null from all three input fields');
      expect(finding.message).toContain('retaining positions as required');
      expect(finding.message).toContain('keep MeshGeometry.indices required nullable at the stored geometry boundary');
      expect(finding.message).toContain('empty present collection still enters the supplied-data path');
      expect(finding.message).toContain('normalize it once into this optional non-null construction shape');
      expect(finding.message).toContain('Do not whitelist the redundant construction spelling');
      expect(finding.message).toContain('will not choose or collapse an absence sentinel');
      expect(finding.message).toContain('substitute an empty collection');
      expect(finding.message).toContain('merge the array and typed-array owners');
      expect(finding.message).toContain('route elements through Any');
      expect(finding.message).toContain('or add side storage');
    }
    expect(findings[0]?.message).toContain(
      'present readonly array, Uint16Array, or Uint32Array is copied element by element',
    );
    expect(findings[0]?.message).toContain('fresh Uint16Array or Uint32Array selected from the vertex count');
    expect(findings[0]?.message).toContain('absence leaves the local indexArray undefined');
    expect(findings[0]?.message).toContain('required-null MeshGeometry.indices storage slot');
    expect(findings[1]?.message).toContain('present readonly array is copied into the canonical normal channels');
    expect(findings[1]?.message).toContain('computeMeshGeometryNormals to derive from the faces');
    expect(findings[2]?.message).toContain('present readonly array is copied into the canonical UV channels');
    expect(findings[2]?.message).toContain('freshly allocated Float32Array cells at zero before tangent computation');
  });

  it('keeps mesh attribute lookalikes generic and accepts either single absence representation', () => {
    const optional = input(
      'packages/types/src/MeshGeometryFromAttributesOptions.ts',
      `interface MeshGeometryFromAttributesOptions {
         indices?: readonly number[] | Uint16Array | Uint32Array;
         normals?: readonly number[];
         positions: readonly number[];
         uvs?: readonly number[];
       }`,
    );
    const nullable = input(
      'packages/types/src/MeshGeometryFromAttributesOptions.ts',
      `interface MeshGeometryFromAttributesOptions {
         indices: readonly number[] | Uint16Array | Uint32Array | null;
         normals: readonly number[] | null;
         positions: readonly number[];
         uvs: readonly number[] | null;
       }`,
    );
    const unrelated = [
      input(
        'packages/types/src/MeshGeometryFromAttributesOptions.ts',
        'interface OtherMeshGeometryOptions { normals?: readonly number[] | null }',
      ),
      input(
        'packages/example/src/MeshGeometryFromAttributesOptions.ts',
        'interface MeshGeometryFromAttributesOptions { uvs?: readonly number[] | null }',
      ),
      input(
        'packages/types/src/MeshGeometryFromAttributesOptions.ts',
        `interface MeshGeometryFromAttributesOptions {
           indices?: readonly number[] | Uint16Array | null;
         }`,
      ),
      input(
        'packages/types/src/MeshGeometryFromAttributesOptions.ts',
        'interface MeshGeometryFromAttributesOptions { tangents?: readonly number[] | null }',
      ),
    ];

    expect(analyzeTypeScriptSourcePortability([optional, nullable]).findings).toEqual([]);
    for (const control of unrelated) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).not.toContain('construction-only mesh attribute input');
      expect(findings[0]?.message).toContain('optional collection input');
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

  it('explains PathAttachment2D point storage from its weighted-first deformation contract', () => {
    const source = input(
      'packages/types/src/PathAttachment2D.ts',
      `interface Attachment2D { kind: string }
       interface Skin2D { influenceCounts: Uint16Array; influences: Float32Array }
       interface PathAttachment2D extends Attachment2D {
         commands: number[];
         kind: 'PathAttachment2D';
         pointCount: number;
         skin?: Skin2D | null;
         vertices?: Float32Array | null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      ['skin', 'vertices'].map((field) => ({
        rule: 'mixed-absence',
        subject: `interface:PathAttachment2D/property:${field}`,
      })),
    );
    for (const finding of findings) {
      expect(finding.message).toContain(`PathAttachment2D.${finding.subject.endsWith(':skin') ? 'skin' : 'vertices'}`);
      expect(finding.message).toContain('deformSkeleton2DPathAttachment passes skin and vertices unchanged');
      expect(finding.message).toContain('a present Skin2D selects weighted deformation and ignores vertices');
      expect(finding.message).toContain('a present Float32Array supplies rigid local points');
      expect(finding.message).toContain('a nullish vertices value causes no coordinate writes');
      expect(finding.message).toContain('explainSkeleton2DDeformLength makes the same dispatch');
      expect(finding.message).toContain('no PathAttachment2D constructor or importer');
      expect(finding.message).toContain('every concrete repository test constructor assigns both fields');
      expect(finding.message).toContain('Make PathAttachment2D.skin a required Skin2D | null field');
      expect(finding.message).toContain('PathAttachment2D.vertices a required Float32Array | null field');
      expect(finding.message).toContain('retain the current weighted-first dispatch');
      expect(finding.message).toContain('one named closed storage state');
      expect(finding.message).toContain('Do not whitelist either redundant absence spelling');
      expect(finding.message).toContain('will not choose or collapse an absence sentinel');
      expect(finding.message).toContain('infer or change the deformation mode');
      expect(finding.message).toContain('fabricate a Skin2D or vertex buffer');
      expect(finding.message).toContain('rewrite commands or pointCount');
      expect(finding.message).toContain('allocate or copy either owner');
      expect(finding.message).toContain('route elements through Any');
      expect(finding.message).toContain('reinterpret or cast storage');
      expect(finding.message).toContain('or add side storage');
      expect(finding.message).not.toContain('Import initializers assign both fields');
    }
  });

  it('keeps PathAttachment2D guidance exact and accepts required nullable or closed storage', () => {
    const controls = [
      input(
        'packages/example/src/PathAttachment2D.ts',
        `interface Attachment2D { kind: string }
         interface Skin2D { influences: Float32Array }
         interface PathAttachment2D extends Attachment2D {
           skin?: Skin2D | null;
           vertices?: Float32Array | null;
         }`,
      ),
      input(
        'packages/types/src/PathAttachment2D.ts',
        `interface Attachment2D { kind: string }
         interface Skin2D { influences: Float32Array }
         interface OtherPathAttachment2D extends Attachment2D {
           skin?: Skin2D | null;
           vertices?: Float32Array | null;
         }`,
      ),
      input(
        'packages/types/src/PathAttachment2D.ts',
        `interface Attachment2D { kind: string }
         interface Skin2D { influences: Float32Array }
         interface PathAttachment2D extends Attachment2D {
           skin?: Skin2D | null;
           vertices?: number[] | null;
         }`,
      ),
    ];
    const required = input(
      'packages/types/src/PathAttachment2D.ts',
      `interface Attachment2D { kind: string }
       interface Skin2D { influences: Float32Array }
       interface PathAttachment2D extends Attachment2D {
         skin: Skin2D | null;
         vertices: Float32Array | null;
       }`,
    );
    const closed = input(
      'packages/types/src/PathAttachment2D.ts',
      `interface Attachment2D { kind: string }
       interface Skin2D { influences: Float32Array }
       type PathPointStorage =
         | { mode: 'empty' }
         | { mode: 'weighted'; skin: Skin2D }
         | { mode: 'rigid'; vertices: Float32Array };
       interface PathAttachment2D extends Attachment2D { points: PathPointStorage }`,
    );
    const findings = analyzeTypeScriptSourcePortability(controls).findings;

    expect(findings).toHaveLength(6);
    expect(findings.every((finding) => !finding.message.includes('path deformation contract'))).toBe(true);
    expect(analyzeTypeScriptSourcePortability([required, closed]).findings).toEqual([]);
  });

  it('explains the one-sentinel contract for internal authored-name storage', () => {
    const sources = [
      input(
        'packages/types/src/Attachment2D.ts',
        `interface Entity { readonly id: number }
         interface Attachment2D extends Entity { kind: string; name?: string | null }`,
      ),
      input('packages/types/src/Bone2D.ts', `interface Bone2D { name?: string | null; parentIndex: number }`),
      input(
        'packages/types/src/Material.ts',
        `interface Entity { readonly id: number }
         interface Material extends Entity { readonly kind: string; name?: string | null }`,
      ),
    ];
    const findings = analyzeTypeScriptSourcePortability(sources).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      ['Attachment2D', 'Bone2D', 'Material'].map((owner) => ({
        rule: 'mixed-absence',
        subject: `interface:${owner}/property:name`,
      })),
    );
    for (const [index, finding] of findings.entries()) {
      const owner = ['Attachment2D', 'Bone2D', 'Material'][index];
      expect(finding.message).toContain(
        `gives the internal ${owner} authored-name slot both omission and explicit null`,
      );
      expect(finding.message).toContain('Spine and DragonBones parsers write a string or null');
      expect(finding.message).toContain('initializeMaterial writes null');
      expect(finding.message).toContain('lookup paths recognize only exact present strings');
      expect(finding.message).toContain(
        'Make Attachment2D.name, Bone2D.name, and Material.name required string | null fields',
      );
      expect(finding.message).toContain('initialize every construction path to null');
      expect(finding.message).toContain('structural convenience inputs must allow omission');
      expect(finding.message).toContain('separate shapes and normalize them once');
      expect(finding.message).toContain('replace the two absence spellings with one named closed state');
      expect(finding.message).toContain('will not choose or collapse an absence sentinel');
      expect(finding.message).toContain('infer a name from kind or position');
      expect(finding.message).toContain('rewrite name lookup');
      expect(finding.message).toContain('clone or materialize an owner');
      expect(finding.message).toContain('reinterpret or cast the string');
      expect(finding.message).toContain('or add side storage');
    }
  });

  it('keeps unrelated authored-name shapes generic and accepts one-sentinel internal storage', () => {
    const controls = [
      input('Other.ts', 'interface Attachment2D { kind: string; name?: string | null }'),
      input('packages/types/src/Attachment2D.ts', 'interface OtherAttachment { name?: string | null }'),
      input('packages/types/src/Bone2D.ts', 'interface Bone2D { label?: string | null }'),
      input('packages/types/src/Material.ts', 'interface Material { name?: String | null }'),
    ];
    const resolved = [
      input('RequiredName.ts', 'interface Material { name: string | null }'),
      input('OptionalName.ts', 'interface Bone2D { name?: string }'),
    ];

    for (const control of controls) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain(
        'combines an optional property with null; choose one absence representation or make all three states explicit.',
      );
      expect(findings[0]?.message).not.toContain('internal Attachment2D authored-name slot');
      expect(findings[0]?.message).not.toContain('internal Bone2D authored-name slot');
      expect(findings[0]?.message).not.toContain('internal Material authored-name slot');
    }
    expect(analyzeTypeScriptSourcePortability(resolved).findings).toEqual([]);
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
      expect(finding.message).toContain('current Flight gives them one inactive meaning');
      expect(finding.message).toContain('In-memory construction sites omit inactive constraints');
      expect(finding.message).toContain(
        'the generic FlightDocument read, write, and clone paths may preserve an explicit null inside itemStyle',
      );
      expect(finding.message).toContain('without attaching anchor-specific meaning');
      expect(finding.message).toContain('isOptionalNumber accepts both null and undefined');
      expect(finding.message).toContain('anchorLayoutResolver normalizes left, right, top, and bottom with ?? null');
      expect(finding.message).toContain('When opposing pins do not determine an axis');
      expect(finding.message).toContain('width and height expressions each use ?? intrinsicSizes');
      expect(finding.message).toContain('either absence spelling selects the same natural-size fallback');
      expect(finding.message).toContain('placement uses a pin or alignment');
      expect(finding.message).toContain(
        'Make all six bottom, height, left, right, top, and width constraints optional number fields',
      );
      expect(finding.message).toContain('reserve null for the enclosing LayoutNode.itemStyle no-style sentinel');
      expect(finding.message).toContain('keep that boundary shape separate');
      expect(finding.message).toContain('normalize it once into the optional-number layout style');
      expect(finding.message).toContain('name a closed constraint-state union and handle it separately');
      expect(finding.message).toContain('will not whitelist a redundant spelling');
      expect(finding.message).toContain('will not preserve a redundant third sentinel in target storage');
      expect(finding.message).toContain('zero is a real pin or size');
      expect(finding.message).toContain('collapse a present value');
      expect(finding.message).toContain('rewrite an input boundary, or add side storage');
    }
  });

  it('keeps unrelated layout properties generic and accepts one-sentinel anchor constraints', () => {
    const unrelatedOwner = input('OtherLayoutStyle.ts', 'interface OtherLayoutStyle { left?: number | null }');
    const unrelatedMember = input(
      'AnchorLayoutItemStyle.ts',
      'interface AnchorLayoutItemStyle { gap?: number | null }',
    );
    const unrelatedLocation = input(
      'packages/example/src/Layout.ts',
      'interface AnchorLayoutItemStyle { left?: number | null }',
    );
    const unrelatedType = input(
      'packages/types/src/Layout.ts',
      'interface AnchorLayoutItemStyle { left?: string | null }',
    );
    const optionalNumber = input('packages/types/src/Layout.ts', 'interface AnchorLayoutItemStyle { left?: number }');
    const requiredNullable = input(
      'packages/types/src/Layout.ts',
      'interface AnchorLayoutItemStyle { left: number | null }',
    );
    const explicit = input(
      'packages/types/src/Layout.ts',
      `type AnchorConstraint =
         | { readonly state: 'cleared' }
         | { readonly state: 'omitted' }
         | { readonly state: 'present'; readonly value: number };
       interface AnchorLayoutItemStyle { left: AnchorConstraint }`,
    );
    const findings = analyzeTypeScriptSourcePortability([
      unrelatedOwner,
      unrelatedMember,
      unrelatedLocation,
      unrelatedType,
    ]).findings;

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
      {
        message:
          'interface:AnchorLayoutItemStyle/property:left combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:AnchorLayoutItemStyle/property:left',
      },
    ]);
    expect(findings.every((finding) => !finding.message.includes('anchorLayoutResolver'))).toBe(true);
    expect(analyzeTypeScriptSourcePortability([optionalNumber, requiredNullable, explicit]).findings).toEqual([]);
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
      expect(finding.message).toContain('the current renderers have one inactive state');
      expect(finding.message).toContain(
        'GL and WebGPU overwrite colorMatrix, colorScaleBias, jointMatrices, and normalMatrices with a value or null on every draw',
      );
      expect(finding.message).toContain(
        'each writes instanceMatrices for an instanced draw before clearing it to null afterward',
      );
      expect(finding.message).toContain('GL likewise writes and clears its separate instanceColors slot');
      expect(finding.message).toContain(
        'WebGPU instead packs instance colors beside matrices in one instance buffer and never reads that slot',
      );
      expect(finding.message).toContain(
        'Shader preparation treats null and undefined identically with nullish checks before binding or uploading',
      );
      expect(finding.message).toContain(
        'Make all six colorMatrix, colorScaleBias, instanceColors, instanceMatrices, jointMatrices, and normalMatrices slots required nullable fields',
      );
      expect(finding.message).toContain(
        'initialize all six to null, and overwrite or clear every backend-owned slot before each draw',
      );
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
    const morph = findings[0]!.message;
    expect(morph).toContain('mesh deformation slot morph both an omitted state and explicit null');
    expect(morph).toContain('createMesh omits morph');
    expect(morph).toContain('cloneMesh and scene-document import assign it only when a MeshMorph is present');
    expect(morph).toContain('updateMeshMorph, getMeshDeformer, animation routing, and the GL deform guard');
    expect(morph).toContain('GL and WebGPU draw the geometry that preparation updates');
    expect(morph).toContain('Make morph an optional non-null MeshMorph field');
    expect(morph).toContain('infer or create a morph');
    expect(morph).toContain('rewrite or clone the mesh or its geometry');

    const skin = findings[1]!.message;
    expect(skin).toContain('mesh deformation slot skin both an omitted state and explicit null');
    expect(skin).toContain('createMesh omits skin');
    expect(skin).toContain('cloneMesh and scene-document import assign it only when a Skin is present');
    expect(skin).toContain('updateMeshSkin and prepareMeshSkinning return on a nullish skin');
    expect(skin).toContain('GL forward and shadow draws require skin != null');
    expect(skin).toContain('the WebGPU skin adapter returns false for skin == null');
    expect(skin).toContain('Make skin an optional non-null Skin field');
    expect(skin).toContain('infer or create a skin or palette');

    const bounds = findings[2]!.message;
    expect(bounds).toContain('mesh deformation slot deformedLocalBounds both an omitted state and explicit null');
    expect(bounds).toContain('prepareMeshSkinning is its producer');
    expect(bounds).toContain('allocates and stores one Aabb when the slot is nullish');
    expect(bounds).toContain('Shared culling before GL or WebGPU draws falls back with ?? to geometry bounds');
    expect(bounds).toContain('picking uses a nullish presence check');
    expect(bounds).toContain('the GL deform guard treats both absence spellings alike');
    expect(bounds).toContain('Make deformedLocalBounds an optional non-null Aabb field');
    expect(bounds).toContain('infer bounds or run skinning');

    for (const finding of findings) {
      expect(finding.message).toContain('use omission or undefined as its sole');
      expect(finding.message).toContain('normalize it once');
      expect(finding.message).toContain('will not preserve a redundant null sentinel');
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

  it('explains the required-nullable contract for Skeleton2D wardrobe and slot collections', () => {
    const source = input(
      'packages/types/src/Skeleton2D.ts',
      `interface AttachmentSkin2D { readonly name: string }
       interface Slot2D { readonly boneIndex: number }
       interface Skeleton2D {
         skins?: AttachmentSkin2D[] | null;
         slots?: Slot2D[] | null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      {
        rule: 'mixed-absence',
        subject: 'interface:Skeleton2D/property:skins',
      },
      {
        rule: 'mixed-absence',
        subject: 'interface:Skeleton2D/property:slots',
      },
    ]);

    const skins = findings[0]!.message;
    expect(skins).toContain('retained Skeleton2D wardrobe list both omission and explicit null');
    expect(skins).toContain('createSkeleton2D always initializes skins to null');
    expect(skins).toContain('Spine JSON, Spine binary, and DragonBones importers leave that null intact');
    expect(skins).toContain('overwrite it only with a non-empty AttachmentSkin2D array');
    expect(skins).toContain("Rive's pure-bone skeleton likewise retains null");
    expect(skins).toContain('cloneSkeleton2D preserves the exact skins array owner rather than copying it');
    expect(skins).toContain('getSkeleton2DSkin returns null for either undefined or null');
    expect(skins).toContain('Make Skeleton2D.skins a required AttachmentSkin2D[] | null field');
    expect(skins).toContain("retain each importer's non-empty assignment plus the clone's shared array identity");
    expect(skins).toContain('infer or parse a wardrobe');
    expect(skins).toContain('copy or materialize the skin collection or its attachment owners');

    const slots = findings[1]!.message;
    expect(slots).toContain('live Skeleton2D slot and draw-order list both omission and explicit null');
    expect(slots).toContain('createSkeleton2D defaults slots to null');
    expect(slots).toContain('Spine JSON, Spine binary, and DragonBones importers pass their parsed Slot2D array');
    expect(slots).toContain("Rive's pure-bone skeleton keeps the default null");
    expect(slots).toContain('cloneSkeleton2D allocates new records for a present slot array');
    expect(slots).toContain('disposeSkeleton2D explicitly clears the cell to null');
    expect(slots).toContain('setSkeleton2DSkin, slot animation, deform animation, and path-attachment resolution');
    expect(slots).toContain('Make Skeleton2D.slots a required Slot2D[] | null field');
    expect(slots).toContain('preserve null as the pure-rig and disposed sentinel');
    expect(slots).toContain('solve a path constraint');
    expect(slots).toContain('beyond the authored clone');

    for (const finding of findings) {
      expect(finding.message).toContain('A present empty array remains');
      expect(finding.message).toContain('must not be');
      expect(finding.message).toContain('give them a separate shape and normalize once');
      expect(finding.message).toContain('can retain the current null, undefined, and exact array alternatives');
      expect(finding.message).toContain('represent the required-nullable rewrite without Any');
      expect(finding.message).toContain('does not give the second absence spelling a source meaning');
      expect(finding.message).toContain('will not whitelist a redundant absence spelling');
      expect(finding.message).toContain('substitute an empty array');
      expect(finding.message).toContain('reinterpret or cast');
      expect(finding.message).toContain('or add side storage');
    }
  });

  it('keeps unrelated Skeleton2D-like collections generic and accepts one live absence state', () => {
    const controls = [
      input('Other.ts', 'interface Skeleton2D { skins?: AttachmentSkin2D[] | null }'),
      input('packages/types/src/Skeleton2D.ts', 'interface OtherSkeleton { slots?: Slot2D[] | null }'),
      input('packages/example/src/Skeleton2D.ts', 'interface Skeleton2D { slots?: Slot2D[] | null }'),
      input('packages/types/src/Skeleton2D.ts', 'interface Skeleton2D { attachments?: Slot2D[] | null }'),
      input('packages/types/src/Skeleton2D.ts', 'interface Skeleton2D { skins?: Skin2D[] | null }'),
      input('packages/types/src/Skeleton2D.ts', 'interface Skeleton2D { slots?: readonly Slot2D[] | null }'),
    ];
    const resolved = input(
      'packages/types/src/Skeleton2D.ts',
      `interface AttachmentSkin2D { readonly name: string }
       interface Slot2D { readonly boneIndex: number }
       interface Skeleton2D {
         skins: AttachmentSkin2D[] | null;
         slots: Slot2D[] | null;
       }`,
    );

    expect(analyzeTypeScriptSourcePortability([resolved]).findings).toEqual([]);
    for (const control of controls) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]!.message).toContain('combines an optional property with null');
      expect(findings[0]!.message).not.toContain('retained Skeleton2D wardrobe list');
      expect(findings[0]!.message).not.toContain('live Skeleton2D slot and draw-order list');
    }
  });

  it('explains the one-sentinel contract for live Slot2D fields', () => {
    const source = input(
      'packages/types/src/Slot2D.ts',
      `interface Attachment2D { readonly kind: string }
       interface Skeleton2DSlotDeform { readonly offsets: Float32Array }
       interface Slot2D {
         attachment?: Attachment2D | null;
         deform?: Skeleton2DSlotDeform | null;
         boneIndex: number;
         name?: string | null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      ['attachment', 'deform', 'name'].map((name) => ({
        rule: 'mixed-absence',
        subject: `interface:Slot2D/property:${name}`,
      })),
    );

    const attachment = findings[0]!.message;
    expect(attachment).toContain('live Slot2D attachment cell both omission and explicit null');
    expect(attachment).toContain('Spine JSON and binary importers construct every slot with attachment: null');
    expect(attachment).toContain('DragonBones constructs it with a resolved Attachment2D or null');
    expect(attachment).toContain('setSkeleton2DSkin, and attachment animation later overwrite that same cell');
    expect(attachment).toContain('resolveSkeleton2DPathAttachment rejects undefined and null identically');
    expect(attachment).toContain('getSkeleton2DSlotDeformOffsets compares slot.attachment ?? null');
    expect(attachment).toContain('Make Slot2D.attachment a required Attachment2D | null field');
    expect(attachment).toContain('infer or resolve an attachment');

    const deform = findings[1]!.message;
    expect(deform).toContain('live Slot2D deform cell both a never-written undefined state and an explicit null clear');
    expect(deform).toContain('format importers construct slots without deform');
    expect(deform).toContain('setSkeleton2DSlotDeform writes null when clearing');
    expect(deform).toContain('reuses a present same-sized record');
    expect(deform).toContain('getSkeleton2DSlotDeformOffsets returns null for both absence spellings');
    expect(deform).toContain('attachment swaps intentionally leave the record in place');
    expect(deform).toContain('Make Slot2D.deform a required Skeleton2DSlotDeform | null field');
    expect(deform).toContain('change buffer reuse');

    const name = findings[2]!.message;
    expect(name).toContain('Slot2D authored-name cell both omission and explicit null');
    expect(name).toContain('Spine JSON and DragonBones importers normalize a non-string slot name to null');
    expect(name).toContain('binary reader returns string | null');
    expect(name).toContain('skin, animation, and draw-order resolution paths call indexOfSpineSlot');
    expect(name).toContain('Make Slot2D.name a required string | null field');
    expect(name).toContain('infer a name from the bone, attachment, kind, or position');

    for (const finding of findings) {
      expect(finding.message).toContain('cloneSkeleton2D copies');
      expect(finding.message).toContain('give them a separate shape and normalize once');
      expect(finding.message).toContain('will not whitelist a redundant absence spelling');
      expect(finding.message).toContain('or add side storage');
    }
  });

  it('keeps unrelated optional-nullable slot properties generic and accepts required nullable live storage', () => {
    const controls = [
      input('OtherSlot2D.ts', 'interface OtherSlot2D { attachment?: Attachment2D | null }'),
      input('packages/types/src/Slot2D.ts', 'interface Slot2D { colorAdjustment?: Attachment2D | null }'),
      input('packages/example/src/Slot2D.ts', 'interface Slot2D { deform?: Skeleton2DSlotDeform | null }'),
      input('packages/types/src/Slot2D.ts', 'interface Slot2D { name?: String | null }'),
    ];
    const resolved = input(
      'packages/types/src/Slot2D.ts',
      `interface Attachment2D { readonly kind: string }
       interface Skeleton2DSlotDeform { readonly offsets: Float32Array }
       interface Slot2D {
         attachment: Attachment2D | null;
         deform: Skeleton2DSlotDeform | null;
         name: string | null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability(controls).findings;

    expect(findings).toHaveLength(4);
    expect(
      findings.every((finding) =>
        finding.message.endsWith('choose one absence representation or make all three states explicit.'),
      ),
    ).toBe(true);
    expect(findings.every((finding) => !finding.message.includes('live Slot2D'))).toBe(true);
    expect(analyzeTypeScriptSourcePortability([resolved]).findings).toEqual([]);
  });

  it('explains the construction-only absence contract for BitmapText numeric options', () => {
    const source = input(
      'packages/types/src/BitmapText.ts',
      `interface BitmapTextOptions {
         align?: 'left' | 'right';
         maxLines?: number | null;
         wrapWidth?: number | null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      ['maxLines', 'wrapWidth'].map((name) => ({
        rule: 'mixed-absence',
        subject: `interface:BitmapTextOptions/property:${name}`,
      })),
    );
    for (const [index, finding] of findings.entries()) {
      const name = ['maxLines', 'wrapWidth'][index];
      expect(finding.message).toContain(
        `gives the BitmapText construction option ${name} both omission and explicit null`,
      );
      expect(finding.message).toContain('createBitmapText applies this option only to fresh BitmapTextData');
      expect(finding.message).toContain(
        'initializeBitmapTextData has already defaulted maxLines and wrapWidth to null',
      );
      expect(finding.message).toContain('applyBitmapTextOptions writes each field only when it is not undefined');
      expect(finding.message).toContain('either absence spelling produces the same stored disabled state');
      expect(finding.message).toContain('Keep BitmapTextData and the dedicated setters required nullable');
      expect(finding.message).toContain(
        'make maxLines and wrapWidth optional number fields in BitmapTextOptions so omission is the sole construction-time absence',
      );
      expect(finding.message).toContain(
        'named closed update state whose unchanged, disabled, and numeric cases are explicit',
      );
      expect(finding.message).toContain('will not choose or collapse an absence sentinel');
      expect(finding.message).toContain('zero is a present limit or width');
      expect(finding.message).toContain('rewrite existing BitmapTextData, call a setter, or add side storage');
    }
  });

  it('keeps unrelated numeric options generic and accepts split BitmapText construction and storage contracts', () => {
    const unrelatedOwner = input('OtherTextOptions.ts', 'interface OtherTextOptions { maxLines?: number | null }');
    const unrelatedMember = input(
      'packages/types/src/BitmapText.ts',
      'interface BitmapTextOptions { letterSpacing?: number | null }',
    );
    const unrelatedLocation = input(
      'packages/example/src/BitmapText.ts',
      'interface BitmapTextOptions { wrapWidth?: number | null }',
    );
    const splitContract = input(
      'BitmapTextSplit.ts',
      `interface BitmapTextData {
         maxLines: number | null;
         wrapWidth: number | null;
       }
       interface BitmapTextCreateOptions {
         maxLines?: number;
         wrapWidth?: number;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([
      unrelatedOwner,
      unrelatedMember,
      unrelatedLocation,
      splitContract,
    ]).findings;

    expect(findings).toMatchObject([
      {
        message:
          'interface:OtherTextOptions/property:maxLines combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:OtherTextOptions/property:maxLines',
      },
      {
        message:
          'interface:BitmapTextOptions/property:wrapWidth combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:BitmapTextOptions/property:wrapWidth',
      },
      {
        message:
          'interface:BitmapTextOptions/property:letterSpacing combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:BitmapTextOptions/property:letterSpacing',
      },
    ]);
    expect(findings.every((finding) => !finding.message.includes('BitmapText construction option'))).toBe(true);
  });

  it('explains the construction-only absence contract for InteractionManager services', () => {
    const source = input(
      'packages/types/src/InteractionManager.ts',
      `interface CursorBackend { setCursor(value: string | null): void }
       interface SpatialIndex2D { readonly capacity: number }
       interface InteractionManagerOptions {
         cursorBackend?: CursorBackend | null;
         enabled?: boolean;
         spatialIndex?: SpatialIndex2D | null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      ['cursorBackend', 'spatialIndex'].map((name) => ({
        rule: 'mixed-absence',
        subject: `interface:InteractionManagerOptions/property:${name}`,
      })),
    );
    for (const [index, finding] of findings.entries()) {
      const name = ['cursorBackend', 'spatialIndex'][index];
      expect(finding.message).toContain(
        `gives the InteractionManager construction option ${name} both omission and explicit null`,
      );
      expect(finding.message).toContain(
        'createInteractionManager passes its options once into initializeInteractionManager for a fresh manager',
      );
      expect(finding.message).toContain('out.cursorBackend = options.cursorBackend ?? null');
      expect(finding.message).toContain('out.spatialIndex = options.spatialIndex ?? null');
      expect(finding.message).toContain('normalize either spelling to the same disabled service');
      expect(finding.message).toContain(
        'applyInteractionCursor, findInteractionTarget, and refreshInteractionSpatialIndex',
      );
      expect(finding.message).toContain(
        'Keep the InteractionManager cursorBackend and spatialIndex fields required nullable',
      );
      expect(finding.message).toContain('make both fields optional non-null in InteractionManagerOptions');
      expect(finding.message).toContain('omission is the sole construction-time absence');
      expect(finding.message).toContain('unchanged, disabled, and installed cases are explicit');
      expect(finding.message).toContain('will not choose or collapse an absence sentinel');
      expect(finding.message).toContain('construct a cursor backend or spatial index');
      expect(finding.message).toContain('change service-owner identity, or add side storage');
    }
  });

  it('keeps unrelated service options generic and accepts split InteractionManager contracts', () => {
    const unrelatedOwner = input(
      'OtherInteractionOptions.ts',
      'interface CursorBackend {} interface OtherInteractionOptions { cursorBackend?: CursorBackend | null }',
    );
    const unrelatedMember = input(
      'packages/types/src/InteractionManager.ts',
      'interface CursorBackend {} interface InteractionManagerOptions { fallbackBackend?: CursorBackend | null }',
    );
    const unrelatedLocation = input(
      'packages/example/src/InteractionManager.ts',
      'interface SpatialIndex2D {} interface InteractionManagerOptions { spatialIndex?: SpatialIndex2D | null }',
    );
    const unrelatedType = input(
      'packages/types/src/InteractionManager.ts',
      'interface OtherBackend {} interface InteractionManagerOptions { cursorBackend?: OtherBackend | null }',
    );
    const splitContract = input(
      'InteractionManagerSplit.ts',
      `interface CursorBackend {}
       interface SpatialIndex2D {}
       interface InteractionManager {
         cursorBackend: CursorBackend | null;
         spatialIndex: SpatialIndex2D | null;
       }
       interface InteractionManagerCreateOptions {
         cursorBackend?: CursorBackend;
         spatialIndex?: SpatialIndex2D;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([
      unrelatedOwner,
      unrelatedMember,
      unrelatedLocation,
      unrelatedType,
      splitContract,
    ]).findings;

    expect(findings).toHaveLength(4);
    expect(findings.map(({ subject }) => subject).sort()).toEqual(
      [
        'interface:InteractionManagerOptions/property:cursorBackend',
        'interface:InteractionManagerOptions/property:fallbackBackend',
        'interface:InteractionManagerOptions/property:spatialIndex',
        'interface:OtherInteractionOptions/property:cursorBackend',
      ].sort(),
    );
    for (const finding of findings) {
      expect(finding.message).toContain(
        'combines an optional property with null; choose one absence representation or make all three states explicit.',
      );
      expect(finding.message).not.toContain('InteractionManager construction option');
    }
  });

  it('explains the provider-boundary normalization for Capacitor altitude accuracy', () => {
    const source = input(
      'packages/types/src/CapacitorApi.ts',
      `interface CapacitorPositionCoords {
         accuracy: number;
         altitude: number | null;
         altitudeAccuracy: number | null | undefined;
         latitude: number;
         longitude: number;
       }
       interface GeoPosition {
         altitudeAccuracy: number;
       }
       function toGeoPosition(coords: Readonly<CapacitorPositionCoords>): GeoPosition {
         return { altitudeAccuracy: coords.altitudeAccuracy ?? 0 };
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings).toMatchObject([
      {
        rule: 'mixed-absence',
        subject: 'interface:CapacitorPositionCoords/property:altitudeAccuracy',
      },
    ]);
    const message = findings[0]?.message;
    expect(message).toContain(
      'gives the Capacitor geolocation provider coordinate altitudeAccuracy both explicit null and explicit undefined',
    );
    expect(message).toContain("host-capacitor's toGeoPosition evaluates coords.altitudeAccuracy ?? 0");
    expect(message).toContain('required numeric GeoPosition.altitudeAccuracy');
    expect(message).toContain('Both absence sentinels therefore become the same zero fallback at provider ingress');
    expect(message).toContain('a present zero remains a real reported accuracy');
    expect(message).toContain('Keep GeoPosition.altitudeAccuracy a required number');
    expect(message).toContain('retain one explicit nullish normalization at the adapter boundary');
    expect(message).toContain('give CapacitorPositionCoords.altitudeAccuracy exactly one provider-side absence');
    expect(message).toContain('required number | null when the provider guarantees the field');
    expect(message).toContain('optional number without null when omission is its contract');
    expect(message).toContain('model a named closed provider state');
    expect(message).toContain('will not choose or collapse an absence sentinel');
    expect(message).toContain('replace a present zero');
    expect(message).toContain('select or synthesize a numeric fallback');
    expect(message).toContain('rewrite the host adapter or canonical coordinate storage');
    expect(message).toContain('reinterpret or cast the value');
    expect(message).toContain('or add side storage');
  });

  it('keeps unrelated nullish numbers generic and accepts one provider-side absence', () => {
    const unrelated = [
      input(
        'packages/types/src/CapacitorApi.ts',
        'interface OtherPositionCoords { altitudeAccuracy: number | null | undefined }',
      ),
      input(
        'packages/types/src/CapacitorApi.ts',
        'interface CapacitorPositionCoords { verticalAccuracy: number | null | undefined }',
      ),
      input(
        'packages/example/src/CapacitorApi.ts',
        'interface CapacitorPositionCoords { altitudeAccuracy: number | null | undefined }',
      ),
      input(
        'packages/types/src/CapacitorApi.ts',
        'interface CapacitorPositionCoords { altitudeAccuracy: string | null | undefined }',
      ),
      input(
        'packages/types/src/CapacitorApi.ts',
        'interface CapacitorPositionCoords { altitudeAccuracy?: number | null }',
      ),
    ];
    const resolved = input(
      'ResolvedCapacitorPositionCoords.ts',
      `interface CapacitorPositionCoordsWithNull { altitudeAccuracy: number | null }
       interface CapacitorPositionCoordsWithOmission { altitudeAccuracy?: number }
       type ProviderAltitudeAccuracy =
         | { readonly state: 'missing' }
         | { readonly state: 'reported'; readonly value: number };
       interface GeoPosition { altitudeAccuracy: number }`,
    );

    expect(analyzeTypeScriptSourcePortability([resolved]).findings).toEqual([]);
    for (const control of unrelated) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain(
        'combines an optional property with null; choose one absence representation or make all three states explicit.',
      );
      expect(findings[0]?.message).not.toContain('Capacitor geolocation provider coordinate');
    }
  });

  it('explains paired morph-gradient matrix normalization into resolved binding storage', () => {
    const source = input(
      'packages/types/src/MorphShape.ts',
      `interface Matrix { readonly a: number }
       interface MorphShapeGradientEndpoint {
         readonly colors: readonly number[];
         readonly matrix?: Readonly<Matrix> | null;
       }
       interface MorphShapeGradientPaintBinding {
         readonly endMatrix: Readonly<Matrix> | null;
         readonly startMatrix: Readonly<Matrix> | null;
       }
       declare const identityMatrix: Readonly<Matrix>;
       declare function cloneMatrix(matrix: Readonly<Matrix>): Readonly<Matrix>;
       function appendMorphShapeGradientPaint(
         start: Readonly<MorphShapeGradientEndpoint>,
         end: Readonly<MorphShapeGradientEndpoint>,
       ): MorphShapeGradientPaintBinding {
         const startSource = start.matrix ?? null;
         const endSource = end.matrix ?? null;
         const hasMatrix = startSource !== null || endSource !== null;
         return {
           startMatrix: hasMatrix ? cloneMatrix(startSource ?? identityMatrix) : null,
           endMatrix: hasMatrix ? cloneMatrix(endSource ?? identityMatrix) : null,
         };
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings).toMatchObject([
      {
        rule: 'mixed-absence',
        subject: 'interface:MorphShapeGradientEndpoint/property:matrix',
      },
    ]);
    const message = findings[0]?.message;
    expect(message).toContain('gives the paired morph-gradient endpoint matrix both omission and explicit null');
    expect(message).toContain('appendMorphShapeGradientPaint evaluates start.matrix ?? null and end.matrix ?? null');
    expect(message).toContain('an absent side uses identityMatrix and both resolved matrices are cloned');
    expect(message).toContain('MorphShapeGradientPaintBinding.startMatrix and endMatrix are both null');
    expect(message).toContain('a present identity matrix is still an authored matrix value');
    expect(message).toContain("Keep the binding's startMatrix and endMatrix fields required Readonly<Matrix> | null");
    expect(message).toContain('declare MorphShapeGradientEndpoint.matrix as optional Readonly<Matrix> without null');
    expect(message).toContain('omission is the sole authoring-time absence');
    expect(message).toContain('one named closed endpoint state and resolve every arm');
    expect(message).toContain('will not choose or collapse an absence sentinel');
    expect(message).toContain('treat a present identity matrix as absent');
    expect(message).toContain('infer the paired endpoint');
    expect(message).toContain('select or synthesize identityMatrix');
    expect(message).toContain('clone or materialize a Matrix');
    expect(message).toContain('rewrite paint sampling or binding storage');
    expect(message).toContain('reinterpret or cast the value');
    expect(message).toContain('or add side storage');
  });

  it('keeps unrelated endpoint matrices generic and accepts split authoring and binding contracts', () => {
    const unrelated = [
      input(
        'packages/types/src/MorphShape.ts',
        'interface Matrix {} interface OtherGradientEndpoint { matrix?: Readonly<Matrix> | null }',
      ),
      input(
        'packages/types/src/MorphShape.ts',
        'interface Matrix {} interface MorphShapeGradientEndpoint { transform?: Readonly<Matrix> | null }',
      ),
      input(
        'packages/example/src/MorphShape.ts',
        'interface Matrix {} interface MorphShapeGradientEndpoint { matrix?: Readonly<Matrix> | null }',
      ),
      input(
        'packages/types/src/MorphShape.ts',
        'interface Matrix3 {} interface MorphShapeGradientEndpoint { matrix?: Readonly<Matrix3> | null }',
      ),
      input(
        'packages/types/src/MorphShape.ts',
        'interface Matrix {} interface MorphShapeGradientEndpoint { matrix?: Matrix | null }',
      ),
    ];
    const resolved = input(
      'ResolvedMorphShapeGradient.ts',
      `interface Matrix { readonly a: number }
       interface MorphShapeGradientEndpoint { matrix?: Readonly<Matrix> }
       interface MorphShapeGradientPaintBinding {
         endMatrix: Readonly<Matrix> | null;
         startMatrix: Readonly<Matrix> | null;
       }
       type GradientMatrixInput =
         | { readonly state: 'absent' }
         | { readonly matrix: Readonly<Matrix>; readonly state: 'present' };`,
    );

    expect(analyzeTypeScriptSourcePortability([resolved]).findings).toEqual([]);
    for (const control of unrelated) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain(
        'combines an optional property with null; choose one absence representation or make all three states explicit.',
      );
      expect(findings[0]?.message).not.toContain('paired morph-gradient endpoint matrix');
    }
  });

  it('explains the create-only texture resource association', () => {
    const source = input(
      'packages/types/src/CreateTextureOptions.ts',
      `interface ImageResourceReference { textures?: Texture[] }
       interface Texture { readonly dimension: string }
       interface TextureLike extends Texture {}
       type CreateTextureVariantOptions<Type extends TextureLike> = Partial<Type>;
       type CreateTextureOptions = CreateTextureVariantOptions<TextureLike> & {
         readonly resource?: ImageResourceReference | null;
       };
       declare function attachTextureToResource(
         texture: Texture,
         resource: ImageResourceReference | null | undefined,
       ): void;
       function createTexture(opts?: Readonly<CreateTextureOptions>): Texture {
         const texture = { dimension: 'cube' };
         attachTextureToResource(texture, opts?.resource);
         return texture;
       }
       function createTexture2D(opts?: Readonly<CreateTextureOptions>): Texture {
         const texture = { dimension: '2d' };
         attachTextureToResource(texture, opts?.resource);
         return texture;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings).toMatchObject([
      {
        rule: 'mixed-absence',
        subject: 'type:CreateTextureOptions/property:resource',
      },
    ]);
    const message = findings[0]?.message;
    expect(message).toContain('gives the create-only texture resource association both omission and explicit null');
    expect(message).toContain('createTexture and createTexture2D each pass opts?.resource to attachTextureToResource');
    expect(message).toContain('resource != null guard skips both absence spellings');
    expect(message).toContain('a present ImageResourceReference owner');
    expect(message).toContain('present resource receives the texture exactly once');
    expect(message).toContain('Declare CreateTextureOptions.resource as optional ImageResourceReference without null');
    expect(message).toContain('omission is the sole no-association input');
    expect(message).toContain('one named closed association state and handle every arm explicitly');
    expect(message).toContain('will not choose or collapse an absence sentinel');
    expect(message).toContain('attach or detach a texture');
    expect(message).toContain('infer a resource from its source');
    expect(message).toContain('allocate or mutate the resource texture list');
    expect(message).toContain('copy or materialize either owner');
    expect(message).toContain('rewrite dimension dispatch');
    expect(message).toContain('reinterpret or cast the association');
    expect(message).toContain('or add side storage');
  });

  it('keeps unrelated resource options generic and accepts one association absence state', () => {
    const unrelated = [
      input(
        'packages/types/src/CreateTextureOptions.ts',
        `interface ImageResourceReference {}
         type OtherTextureOptions = { resource?: ImageResourceReference | null };`,
      ),
      input(
        'packages/types/src/CreateTextureOptions.ts',
        `interface ImageResourceReference {}
         type CreateTextureOptions = { imageResource?: ImageResourceReference | null };`,
      ),
      input(
        'packages/example/src/CreateTextureOptions.ts',
        `interface ImageResourceReference {}
         type CreateTextureOptions = { resource?: ImageResourceReference | null };`,
      ),
      input(
        'packages/types/src/CreateTextureOptions.ts',
        `interface ResourceReference {}
         type CreateTextureOptions = { resource?: ResourceReference | null };`,
      ),
      input(
        'packages/types/src/CreateTextureOptions.ts',
        `interface ImageResourceReference {}
         interface CreateTextureOptions { resource?: ImageResourceReference | null }`,
      ),
    ];
    const resolved = input(
      'ResolvedCreateTextureOptions.ts',
      `interface ImageResourceReference {}
       interface TextureCreateInput { resource?: ImageResourceReference }
       interface TextureAssociation { resource: ImageResourceReference | null }
       type TextureResourceAssociation =
         | { readonly state: 'absent' }
         | { readonly resource: ImageResourceReference; readonly state: 'present' };`,
    );

    expect(analyzeTypeScriptSourcePortability([resolved]).findings).toEqual([]);
    for (const control of unrelated) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain(
        'combines an optional property with null; choose one absence representation or make all three states explicit.',
      );
      expect(findings[0]?.message).not.toContain('create-only texture resource association');
    }
  });

  it('explains the construction-only absence contract for TreeViewController initial selection', () => {
    const source = input(
      'packages/types/src/TreeViewController.ts',
      `interface GuiControllerOptions { transition?: string }
       interface TreeViewControllerItem { readonly visual: object }
       interface TreeViewControllerOptions extends GuiControllerOptions {
         items: readonly Readonly<TreeViewControllerItem>[];
         selectedItem?: TreeViewControllerItem | null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings).toMatchObject([
      {
        rule: 'mixed-absence',
        subject: 'interface:TreeViewControllerOptions/property:selectedItem',
      },
    ]);
    const message = findings[0]?.message ?? '';
    expect(message).toContain(
      'gives the one-shot TreeViewController initial selection both omission and explicit null',
    );
    expect(message).toContain('selectedItem: options.selectedItem ?? null');
    expect(message).toContain('required Readonly<TreeViewControllerItem> | null runtime storage');
    expect(message).toContain('present item owner is retained unchanged');
    expect(message).toContain('live setter accepts an item or null');
    expect(message).toContain('normalizes a foreign item to null');
    expect(message).toContain('disposal clears the runtime field to null');
    expect(message).toContain(
      'Declare TreeViewControllerOptions.selectedItem as optional TreeViewControllerItem without null',
    );
    expect(message).toContain('keeping the runtime field, setter parameter, and getter result required nullable');
    expect(message).toContain('replace the property with one named closed selection state');
    expect(message).toContain('will not choose or collapse an absence sentinel');
    expect(message).toContain('select or validate an item');
    expect(message).toContain('emit a selection signal');
    expect(message).toContain('infer an item from the roots');
    expect(message).toContain('copy or materialize the item owner');
    expect(message).toContain('rewrite controller disposal or navigation');
    expect(message).toContain('reinterpret or cast the selection');
    expect(message).toContain('or add side storage');
  });

  it('keeps unrelated selection shapes generic and accepts one-sentinel TreeViewController inputs', () => {
    const controls = [
      input(
        'TreeViewController.ts',
        'interface TreeViewControllerItem {} interface TreeViewControllerOptions { selectedItem?: TreeViewControllerItem | null }',
      ),
      input(
        'packages/types/src/TreeViewController.ts',
        'interface TreeViewControllerItem {} interface OtherControllerOptions { selectedItem?: TreeViewControllerItem | null }',
      ),
      input(
        'packages/types/src/TreeViewController.ts',
        'interface TreeViewControllerItem {} interface TreeViewControllerOptions { focusedItem?: TreeViewControllerItem | null }',
      ),
      input(
        'packages/types/src/TreeViewController.ts',
        'interface OtherItem {} interface TreeViewControllerOptions { selectedItem?: OtherItem | null }',
      ),
      input(
        'packages/types/src/TreeViewController.ts',
        'interface TreeViewControllerItem {} interface TreeViewControllerOptions { selectedItem?: Readonly<TreeViewControllerItem> | null }',
      ),
    ];
    const resolved = [
      input(
        'RequiredTreeViewSelection.ts',
        'interface TreeViewControllerItem {} interface Runtime { selectedItem: Readonly<TreeViewControllerItem> | null }',
      ),
      input(
        'OptionalTreeViewSelection.ts',
        'interface TreeViewControllerItem {} interface TreeViewControllerOptions { selectedItem?: TreeViewControllerItem }',
      ),
    ];

    for (const control of controls) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain(
        'combines an optional property with null; choose one absence representation or make all three states explicit.',
      );
      expect(findings[0]?.message).not.toContain('one-shot TreeViewController initial selection');
    }
    expect(analyzeTypeScriptSourcePortability(resolved).findings).toEqual([]);
  });

  it('explains construction-only absence for scene owner options', () => {
    const camera = input(
      'packages/types/src/Camera3DOptions.ts',
      `interface Plane { readonly a: number }
       interface Camera3DOptions {
         far: number;
         near: number;
         nearClipPlane?: Plane | null;
       }`,
    );
    const environment = input(
      'packages/types/src/EnvironmentOptions.ts',
      `interface Texture { readonly version: number }
       interface EnvironmentOptions {
         enabled?: boolean;
         environment?: Texture | null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([camera, environment]).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      {
        rule: 'mixed-absence',
        subject: 'interface:Camera3DOptions/property:nearClipPlane',
      },
      {
        rule: 'mixed-absence',
        subject: 'interface:EnvironmentOptions/property:environment',
      },
    ]);
    const [cameraFinding, environmentFinding] = findings;
    expect(cameraFinding?.message).toContain(
      'gives the Camera3D construction owner nearClipPlane both omission and explicit null',
    );
    expect(cameraFinding?.message).toContain('createCamera3D passes its options once to initializeCamera3D');
    expect(cameraFinding?.message).toContain('out.nearClipPlane = opts.nearClipPlane ?? null');
    expect(cameraFinding?.message).toContain('getCamera3DViewProjectionMatrix4 applies the plane only when present');
    expect(cameraFinding?.message).toContain('reflectCamera3DByPlane copies the live required nullable field directly');
    expect(cameraFinding?.message).toContain('Keep Camera3D.nearClipPlane required nullable');
    expect(cameraFinding?.message).toContain('make Camera3DOptions.nearClipPlane an optional Plane without null');
    expect(cameraFinding?.message).toContain('unchanged, disabled, and present-plane cases are explicit');
    expect(cameraFinding?.message).toContain('infer or construct a Plane');
    expect(cameraFinding?.message).toContain('copy or materialize the plane owner, or add side storage');

    expect(environmentFinding?.message).toContain(
      'gives the Environment construction owner environment both omission and explicit null',
    );
    expect(environmentFinding?.message).toContain('createEnvironment passes its options once to initializeEnvironment');
    expect(environmentFinding?.message).toContain('out.environment = options?.environment ?? null');
    expect(environmentFinding?.message).toContain(
      'GL and WebGPU environment-cube consumers test the required nullable field against null',
    );
    expect(environmentFinding?.message).toContain('Keep Environment.environment required nullable');
    expect(environmentFinding?.message).toContain(
      'make EnvironmentOptions.environment an optional Texture without null',
    );
    expect(environmentFinding?.message).toContain(
      'cloneEnvironment must omit the option when source.environment is null and pass the existing owner unchanged when present',
    );
    expect(environmentFinding?.message).toContain('unchanged, disabled, and present-texture cases are explicit');
    expect(environmentFinding?.message).toContain('infer or construct a Texture');
    expect(environmentFinding?.message).toContain('copy or materialize the texture owner, or add side storage');
    for (const finding of findings) {
      expect(finding.message).toContain('normalize');
      expect(finding.message).toContain('omission is the sole construction-time absence');
      expect(finding.message).toContain('will not choose or collapse an absence sentinel');
    }
  });

  it('keeps unrelated scene owner options generic and accepts split construction contracts', () => {
    const unrelatedOwner = input(
      'packages/types/src/Camera3DOptions.ts',
      'interface Plane {} interface ReflectionOptions { nearClipPlane?: Plane | null }',
    );
    const unrelatedMember = input(
      'packages/types/src/Camera3DOptions.ts',
      'interface Plane {} interface Camera3DOptions { farClipPlane?: Plane | null }',
    );
    const unrelatedType = input(
      'packages/types/src/Camera3DOptions.ts',
      'interface ClipVolume {} interface Camera3DOptions { nearClipPlane?: ClipVolume | null }',
    );
    const unrelatedLocation = input(
      'packages/example/src/EnvironmentOptions.ts',
      'interface Texture {} interface EnvironmentOptions { environment?: Texture | null }',
    );
    const unrelatedEnvironmentMember = input(
      'packages/types/src/EnvironmentOptions.ts',
      'interface Texture {} interface EnvironmentOptions { skybox?: Texture | null }',
    );
    const splitContract = input(
      'SceneOwnerOptionsSplit.ts',
      `interface Plane {}
       interface Texture {}
       interface Camera3D { nearClipPlane: Plane | null }
       interface Camera3DCreateOptions { nearClipPlane?: Plane }
       interface Environment { environment: Texture | null }
       interface EnvironmentCreateOptions { environment?: Texture }`,
    );
    const findings = analyzeTypeScriptSourcePortability([
      unrelatedOwner,
      unrelatedMember,
      unrelatedType,
      unrelatedLocation,
      unrelatedEnvironmentMember,
      splitContract,
    ]).findings;

    expect(findings).toHaveLength(5);
    for (const finding of findings) {
      expect(finding.message).toContain(
        'combines an optional property with null; choose one absence representation or make all three states explicit.',
      );
      expect(finding.message).not.toContain('construction owner');
    }
  });

  it('explains the required nullable contract for the reusable RenderProxy color matrix', () => {
    const source = input(
      'packages/types/src/RenderProxy.ts',
      `interface ColorScaleBias { readonly redScale: number }
       interface RenderProxy {
         colorMatrix?: readonly number[] | null;
         colorScaleBias: ColorScaleBias | null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings).toMatchObject([
      {
        rule: 'mixed-absence',
        subject: 'interface:RenderProxy/property:colorMatrix',
      },
    ]);
    const message = findings[0]?.message;
    expect(message).toContain('gives the reusable RenderProxy colorMatrix slot both omission and explicit null');
    expect(message).toContain('the represented 2D render contract has one inactive state');
    expect(message).toContain('initializeRenderProxy assigns out.colorMatrix = null');
    expect(message).toContain(
      'updateRenderProxyColorScaleBias overwrites it with a resolved matrix or null whenever color adjustment accumulation runs',
    );
    expect(message).toContain('GL and WebGPU 2D consumers use nullish selection or comparison');
    expect(message).toContain('Make RenderProxy.colorMatrix a required readonly number[] | null field');
    expect(message).toContain('alongside required colorScaleBias');
    expect(message).toContain('preserve the initializer and per-update clear');
    expect(message).toContain(
      "narrow resolveInheritedColorMatrix's previous parameter from readonly number[] | null | undefined to readonly number[] | null",
    );
    expect(message).toContain('reuse branch no longer carries an unreachable undefined case');
    expect(message).toContain('name a closed color-adjustment state and handle every state explicitly');
    expect(message).toContain('will not choose or collapse an absence sentinel');
    expect(message).toContain('synthesize or multiply a color matrix');
    expect(message).toContain('rewrite batching or shader selection');
    expect(message).toContain('allocate or copy matrix storage, or add side storage');
  });

  it('keeps unrelated matrix slots generic and accepts required RenderProxy storage', () => {
    const unrelatedOwner = input(
      'packages/types/src/RenderProxy.ts',
      'interface RenderEntry { colorMatrix?: readonly number[] | null }',
    );
    const unrelatedMember = input(
      'packages/types/src/RenderProxy.ts',
      'interface RenderProxy { projectionMatrix?: readonly number[] | null }',
    );
    const unrelatedLocation = input(
      'packages/example/src/RenderProxy.ts',
      'interface RenderProxy { colorMatrix?: readonly number[] | null }',
    );
    const unrelatedElement = input(
      'packages/types/src/RenderProxy.ts',
      'interface RenderProxy { colorMatrix?: readonly string[] | null }',
    );
    const mutableArray = input(
      'packages/types/src/RenderProxy.ts',
      'interface RenderProxy { colorMatrix?: number[] | null }',
    );
    const required = input(
      'RenderProxyResolved.ts',
      `interface ColorScaleBias { readonly redScale: number }
       interface RenderProxy {
         colorMatrix: readonly number[] | null;
         colorScaleBias: ColorScaleBias | null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([
      unrelatedOwner,
      unrelatedMember,
      unrelatedLocation,
      unrelatedElement,
      mutableArray,
      required,
    ]).findings;

    expect(findings).toHaveLength(5);
    for (const finding of findings) {
      expect(finding.message).toContain(
        'combines an optional property with null; choose one absence representation or make all three states explicit.',
      );
      expect(finding.message).not.toContain('reusable RenderProxy colorMatrix slot');
    }
  });

  it('explains one normalized absence state for backend color-adjustment material features', () => {
    const sources = [
      input(
        'packages/types/src/GlRenderState.ts',
        `interface GlColorAdjustmentMaterialFeature { readonly fragmentShaderChunk: string }
         interface GlRenderRegistries {
           colorAdjustmentFeature?: GlColorAdjustmentMaterialFeature | null;
         }`,
      ),
      input(
        'packages/types/src/GlRenderStateOptions.ts',
        `interface GlColorAdjustmentMaterialFeature { readonly fragmentShaderChunk: string }
         interface GlRenderStateOptions {
           colorAdjustmentFeature?: GlColorAdjustmentMaterialFeature | null;
         }`,
      ),
      input(
        'packages/types/src/WgpuRenderState.ts',
        `interface WgpuColorAdjustmentMaterialFeature { readonly fragmentShaderChunk: string }
         interface WgpuRenderRegistries {
           colorAdjustmentFeature?: WgpuColorAdjustmentMaterialFeature | null;
         }`,
      ),
      input(
        'packages/types/src/WgpuRenderStateOptions.ts',
        `interface WgpuColorAdjustmentMaterialFeature { readonly fragmentShaderChunk: string }
         interface WgpuRenderStateOptions {
           colorAdjustmentFeature?: WgpuColorAdjustmentMaterialFeature | null;
         }`,
      ),
    ];
    const findings = analyzeTypeScriptSourcePortability(sources).findings;
    const expected = [
      ['GlRenderRegistries', 'GL', 'live registry slot', 'GlColorAdjustmentMaterialFeature'],
      ['GlRenderStateOptions', 'GL', 'construction option', 'GlColorAdjustmentMaterialFeature'],
      ['WgpuRenderRegistries', 'WebGPU', 'live registry slot', 'WgpuColorAdjustmentMaterialFeature'],
      ['WgpuRenderStateOptions', 'WebGPU', 'construction option', 'WgpuColorAdjustmentMaterialFeature'],
    ] as const;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expected.map(([owner]) => ({
        rule: 'mixed-absence',
        subject: `interface:${owner}/property:colorAdjustmentFeature`,
      })),
    );
    for (const [index, finding] of findings.entries()) {
      const [, backend, role, feature] = expected[index]!;
      expect(finding.message).toContain(
        `gives the ${backend} color-adjustment material feature ${role} both omission and explicit null`,
      );
      expect(finding.message).toContain('the represented opt-in feature contract has one disabled state');
      expect(finding.message).toContain('constructs a fresh registry');
      expect(finding.message).toContain('copies options.colorAdjustmentFeature only when it is not undefined');
      expect(finding.message).toContain('returns registries.colorAdjustmentFeature ?? null');
      expect(finding.message).toContain('all resolve to the same unavailable feature');
      expect(finding.message).toContain('overwrites that exact live registry slot with the backend feature singleton');
      expect(finding.message).toContain('no path restores undefined');
      expect(finding.message).toContain(`colorAdjustmentFeature as optional ${feature} without null`);
      expect(finding.message).toContain(`colorAdjustmentFeature a required ${feature} | null field`);
      expect(finding.message).toContain(
        'assign registries.colorAdjustmentFeature = options.colorAdjustmentFeature ?? null',
      );
      expect(finding.message).toContain('a present feature owner passes unchanged');
      expect(finding.message).toContain('Keep colorAdjustmentFeatureGuard separate');
      expect(finding.message).toContain('never enables rendering behavior');
      expect(finding.message).toContain('one named closed feature-registration state');
      expect(finding.message).toContain('will not choose or collapse an absence sentinel');
      expect(finding.message).toContain('import or register a color-adjustment feature');
      expect(finding.message).toContain('enable color adjustments');
      expect(finding.message).toContain('select or execute shader behavior');
      expect(finding.message).toContain('copy or materialize the feature owner');
      expect(finding.message).toContain('change its backend-specific contract or diagnostic guard');
      expect(finding.message).toContain('reinterpret or cast the feature');
      expect(finding.message).toContain('or add side storage');
    }
  });

  it('keeps unrelated feature slots generic and accepts normalized color-adjustment feature contracts', () => {
    const unrelated = [
      input(
        'packages/types/src/GlRenderState.ts',
        `interface GlColorAdjustmentMaterialFeature {}
         interface OtherGlRenderRegistries {
           colorAdjustmentFeature?: GlColorAdjustmentMaterialFeature | null;
         }`,
      ),
      input(
        'packages/example/src/GlRenderState.ts',
        `interface GlColorAdjustmentMaterialFeature {}
         interface GlRenderRegistries {
           colorAdjustmentFeature?: GlColorAdjustmentMaterialFeature | null;
         }`,
      ),
      input(
        'packages/types/src/GlRenderState.ts',
        `interface GlColorAdjustmentMaterialFeature {}
         interface GlRenderRegistries { colorFeature?: GlColorAdjustmentMaterialFeature | null }`,
      ),
      input(
        'packages/types/src/GlRenderState.ts',
        `interface GlColorAdjustmentMaterialFeatureGuard {}
         interface GlRenderRegistries {
           colorAdjustmentFeature?: GlColorAdjustmentMaterialFeatureGuard | null;
         }`,
      ),
      input(
        'packages/types/src/GlRenderState.ts',
        `interface GlColorAdjustmentMaterialFeatureGuard {}
         interface GlRenderRegistries {
           colorAdjustmentFeatureGuard?: GlColorAdjustmentMaterialFeatureGuard | null;
         }`,
      ),
      input(
        'packages/types/src/WgpuRenderStateOptions.ts',
        `interface GlColorAdjustmentMaterialFeature {}
         interface WgpuRenderStateOptions {
           colorAdjustmentFeature?: GlColorAdjustmentMaterialFeature | null;
         }`,
      ),
    ];
    const resolved = [
      input(
        'packages/types/src/GlRenderState.ts',
        `interface GlColorAdjustmentMaterialFeature {}
         interface GlRenderRegistries { colorAdjustmentFeature: GlColorAdjustmentMaterialFeature | null }`,
      ),
      input(
        'packages/types/src/GlRenderStateOptions.ts',
        `interface GlColorAdjustmentMaterialFeature {}
         interface GlRenderStateOptions { colorAdjustmentFeature?: GlColorAdjustmentMaterialFeature }`,
      ),
      input(
        'packages/types/src/WgpuRenderState.ts',
        `interface WgpuColorAdjustmentMaterialFeature {}
         interface WgpuRenderRegistries { colorAdjustmentFeature: WgpuColorAdjustmentMaterialFeature | null }`,
      ),
      input(
        'packages/types/src/WgpuRenderStateOptions.ts',
        `interface WgpuColorAdjustmentMaterialFeature {}
         interface WgpuRenderStateOptions { colorAdjustmentFeature?: WgpuColorAdjustmentMaterialFeature }`,
      ),
    ];

    expect(analyzeTypeScriptSourcePortability(resolved).findings).toEqual([]);
    for (const control of unrelated) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('combines an optional property with null');
      expect(findings[0]?.message).not.toContain('color-adjustment material feature');
    }
  });

  it('explains one construction-time absence state for backend compressed-texture policies', () => {
    const sources = [
      input(
        'packages/types/src/GlRenderStateOptions.ts',
        `type GlCompressedTextureDecoder = (data: Uint8Array) => Uint8ClampedArray | null;
         type GlCompressedTextureUploader = (data: Uint8Array, decode: GlCompressedTextureDecoder | null) => boolean;
         interface GlRenderStateOptions {
           compressedTextureDecoder?: GlCompressedTextureDecoder | null;
           compressedTextureUpload?: GlCompressedTextureUploader | null;
         }`,
      ),
      input(
        'packages/types/src/WgpuRenderStateOptions.ts',
        `type WgpuCompressedTextureDecoder = (data: Uint8Array) => Uint8ClampedArray | null;
         type WgpuCompressedTextureUploader = (
           data: Uint8Array,
           decode: WgpuCompressedTextureDecoder | null,
         ) => object | null;
         interface WgpuRenderStateOptions {
           compressedTextureDecoder?: WgpuCompressedTextureDecoder | null;
           compressedTextureUpload?: WgpuCompressedTextureUploader | null;
         }`,
      ),
    ];
    const findings = analyzeTypeScriptSourcePortability(sources).findings;
    const expected = [
      ['Gl', 'GL', 'compressedTextureDecoder', 'RGBA fallback decoder', 'Decoder'],
      ['Gl', 'GL', 'compressedTextureUpload', 'container uploader', 'Uploader'],
      ['Wgpu', 'WebGPU', 'compressedTextureDecoder', 'RGBA fallback decoder', 'Decoder'],
      ['Wgpu', 'WebGPU', 'compressedTextureUpload', 'container uploader', 'Uploader'],
    ] as const;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expected.map(([prefix, , field]) => ({
        rule: 'mixed-absence',
        subject: `interface:${prefix}RenderStateOptions/property:${field}`,
      })),
    );
    for (const [index, finding] of findings.entries()) {
      const [prefix, backend, , role, typeSuffix] = expected[index]!;
      expect(finding.message).toContain(
        `gives the ${backend} compressed-texture ${role} construction option both omission and explicit null`,
      );
      expect(finding.message).toContain('the represented fresh-state contract has one disabled input state');
      expect(finding.message).toContain(
        'assigns registries.compressedTextureDecoder = options.compressedTextureDecoder ?? null',
      );
      expect(finding.message).toContain('registries.compressedTextureUpload = options.compressedTextureUpload ?? null');
      expect(finding.message).toContain('into required nullable live registry slots');
      expect(finding.message).toContain('either option absence spelling constructs the same disabled policy');
      expect(finding.message).toContain(`a present ${prefix}CompressedTexture${typeSuffix} owner passes unchanged`);
      expect(finding.message).toContain('checks uploadEntry == null before the compressed path');
      expect(finding.message).toContain('passes decoderEntry ?? null into the uploader');
      expect(finding.message).toContain(`register${prefix}CompressedTextureDecoder`);
      expect(finding.message).toContain('writes the exact decoder or null');
      expect(finding.message).toContain(`register${prefix}CompressedTextureUpload`);
      expect(finding.message).toContain(
        'installs the backend uploader when called without its optional clear argument',
      );
      expect(finding.message).toContain('writes null when explicitly clearing it');
      expect(finding.message).toContain(
        `${prefix}RenderStateOptions.compressedTextureDecoder as optional ${prefix}CompressedTextureDecoder`,
      );
      expect(finding.message).toContain(
        `${prefix}RenderStateOptions.compressedTextureUpload as optional ${prefix}CompressedTextureUploader`,
      );
      expect(finding.message).toContain('both without null');
      expect(finding.message).toContain(`keep ${prefix}RenderRegistries fields required nullable`);
      expect(finding.message).toContain("retain the registrars' nullable live-update contracts");
      expect(finding.message).toContain('named closed policy-update state');
      expect(finding.message).toContain('will not choose or collapse an absence sentinel');
      expect(finding.message).toContain('install or clear a compressed-texture policy');
      expect(finding.message).toContain('invoke a decoder or uploader');
      expect(finding.message).toContain('infer format or device support');
      expect(finding.message).toContain('allocate decoded pixels or a texture');
      expect(finding.message).toContain('copy or materialize either capability owner');
      expect(finding.message).toContain('change the GL or WebGPU callable contract');
      expect(finding.message).toContain('reinterpret or cast a capability');
      expect(finding.message).toContain('or add side storage');
    }
  });

  it('keeps unrelated compressed-texture slots generic and accepts split option and registry contracts', () => {
    const unrelated = [
      input(
        'packages/types/src/GlRenderStateOptions.ts',
        `type GlCompressedTextureDecoder = () => void;
         interface OtherGlOptions { compressedTextureDecoder?: GlCompressedTextureDecoder | null }`,
      ),
      input(
        'packages/example/src/GlRenderStateOptions.ts',
        `type GlCompressedTextureDecoder = () => void;
         interface GlRenderStateOptions { compressedTextureDecoder?: GlCompressedTextureDecoder | null }`,
      ),
      input(
        'packages/types/src/GlRenderStateOptions.ts',
        `type GlCompressedTextureDecoder = () => void;
         interface GlRenderStateOptions { compressedTextureEncoder?: GlCompressedTextureDecoder | null }`,
      ),
      input(
        'packages/types/src/GlRenderStateOptions.ts',
        `type GlCompressedTextureUploader = () => void;
         interface GlRenderStateOptions { compressedTextureDecoder?: GlCompressedTextureUploader | null }`,
      ),
      input(
        'packages/types/src/WgpuRenderStateOptions.ts',
        `type GlCompressedTextureDecoder = () => void;
         interface WgpuRenderStateOptions { compressedTextureDecoder?: GlCompressedTextureDecoder | null }`,
      ),
      input(
        'packages/types/src/GlRenderState.ts',
        `type GlCompressedTextureDecoder = () => void;
         interface GlRenderRegistries { compressedTextureDecoder?: GlCompressedTextureDecoder | null }`,
      ),
      input(
        'packages/types/src/GlRenderStateOptions.ts',
        `type GlCompressedTextureDecoder = () => void;
         interface GlRenderStateOptions {
           compressedTextureDecoder?: Readonly<GlCompressedTextureDecoder> | null;
         }`,
      ),
    ];
    const resolved = [
      input(
        'packages/types/src/GlRenderStateOptions.ts',
        `type GlCompressedTextureDecoder = () => void;
         type GlCompressedTextureUploader = () => void;
         interface GlRenderStateOptions {
           compressedTextureDecoder?: GlCompressedTextureDecoder;
           compressedTextureUpload?: GlCompressedTextureUploader;
         }`,
      ),
      input(
        'packages/types/src/GlRenderState.ts',
        `type GlCompressedTextureDecoder = () => void;
         type GlCompressedTextureUploader = () => void;
         interface GlRenderRegistries {
           compressedTextureDecoder: GlCompressedTextureDecoder | null;
           compressedTextureUpload: GlCompressedTextureUploader | null;
         }`,
      ),
      input(
        'packages/types/src/WgpuRenderStateOptions.ts',
        `type WgpuCompressedTextureDecoder = () => void;
         type WgpuCompressedTextureUploader = () => void;
         interface WgpuRenderStateOptions {
           compressedTextureDecoder?: WgpuCompressedTextureDecoder;
           compressedTextureUpload?: WgpuCompressedTextureUploader;
         }`,
      ),
      input(
        'packages/types/src/WgpuRenderState.ts',
        `type WgpuCompressedTextureDecoder = () => void;
         type WgpuCompressedTextureUploader = () => void;
         interface WgpuRenderRegistries {
           compressedTextureDecoder: WgpuCompressedTextureDecoder | null;
           compressedTextureUpload: WgpuCompressedTextureUploader | null;
         }`,
      ),
    ];

    expect(analyzeTypeScriptSourcePortability(resolved).findings).toEqual([]);
    for (const control of unrelated) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('combines an optional property with null');
      expect(findings[0]?.message).not.toContain('compressed-texture RGBA fallback decoder construction option');
      expect(findings[0]?.message).not.toContain('compressed-texture container uploader construction option');
    }
  });

  it('explains the required nullable contract for opt-in Scene3D diagnostic guards', () => {
    const gl = input(
      'packages/types/src/GlScene3DRuntime.ts',
      `interface GlScene3DRuntime {
         colorSpaceGuard?: (() => void) | null;
         customShaderGuard?: ((state: object, program: object, shaderKey: string) => void) | null;
         deformGuard?: ((mesh: object) => void) | null;
         forwardLightSelectionGuard?: ((lights: Readonly<object>) => void) | null;
         pbrExtensionGuard?: ((extensions: readonly object[]) => void) | null;
       }
       declare const warnColorSpace: () => void;
       function getGlScene3DRuntime(): GlScene3DRuntime {
         return { pbrExtensionGuard: null };
       }
       function enableGlScene3DColorSpaceGuards(): void {
         getGlScene3DRuntime().colorSpaceGuard = warnColorSpace;
       }
       function renderGlScene3D(runtime: GlScene3DRuntime): void {
         runtime.colorSpaceGuard?.();
         const deformGuard = runtime.deformGuard;
         if (deformGuard != null) deformGuard({});
       }`,
    );
    const wgpu = input(
      'packages/types/src/WgpuScene3DRuntime.ts',
      `interface WgpuScene3DRuntime {
         customShaderGuard?: ((state: object, shaderKey: string, source: object, material: object) => void) | null;
         forwardLightSelectionGuard?: ((lights: Readonly<object>) => void) | null;
       }
       function getWgpuScene3DRuntime(): WgpuScene3DRuntime {
         return { customShaderGuard: null, forwardLightSelectionGuard: null };
       }
       function renderWgpuScene3D(runtime: WgpuScene3DRuntime): void {
         runtime.forwardLightSelectionGuard?.({});
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([wgpu, gl]).findings;
    const expected = [
      ['GlScene3DRuntime', 'colorSpaceGuard', 'GL'],
      ['GlScene3DRuntime', 'customShaderGuard', 'GL'],
      ['GlScene3DRuntime', 'deformGuard', 'GL'],
      ['GlScene3DRuntime', 'forwardLightSelectionGuard', 'GL'],
      ['GlScene3DRuntime', 'pbrExtensionGuard', 'GL'],
      ['WgpuScene3DRuntime', 'customShaderGuard', 'WebGPU'],
      ['WgpuScene3DRuntime', 'forwardLightSelectionGuard', 'WebGPU'],
    ] as const;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expected.map(([owner, field]) => ({
        rule: 'mixed-absence',
        subject: `interface:${owner}/property:${field}`,
      })),
    );
    const glFlows = new Map<string, string>([
      ['colorSpaceGuard', 'a direct canvas draw has no render-target color-space declaration'],
      ['customShaderGuard', 'after resolving the exact bound program and shader key'],
      ['deformGuard', 'calls the same closure for each visible mesh'],
      [
        'forwardLightSelectionGuard',
        'punctual lights exceed the forward limit without a prepared per-object selection list',
      ],
      ['pbrExtensionGuard', 'only when extension contribution resolution fails'],
    ]);
    for (const [index, finding] of findings.entries()) {
      const [, field, backend] = expected[index]!;
      expect(finding.message).toContain(
        `gives the opt-in ${backend} Scene3D diagnostic guard slot ${field} both omission and explicit null`,
      );
      expect(finding.message).toContain('the represented per-state runtime has one disabled state');
      if (backend === 'GL') {
        expect(finding.message).toContain(glFlows.get(field)!);
        expect(finding.message).toContain('creates one runtime per GlRenderState');
        expect(finding.message).toContain(
          'currently omits colorSpaceGuard, customShaderGuard, deformGuard, and forwardLightSelectionGuard while assigning pbrExtensionGuard: null',
        );
        expect(finding.message).toContain('Every enable function overwrites its exact slot');
        expect(finding.message).toContain('no path clears a guard back to either absence spelling');
        expect(finding.message).toContain('pbrExtensionGuard initializer is already semantically required');
        expect(finding.message).toContain('an omitted undefined slot would incorrectly report enabled');
        expect(finding.message).toContain(
          'Make all five guard slots required fields with their exact callable type | null',
        );
        expect(finding.message).toContain('initialize all five to null in the runtime object literal');
        expect(finding.message).toContain('project the sole exact callable alternative');
        expect(finding.message).toContain('assignments, probes, optional calls, and the guarded local call');
        expect(finding.message).toContain("does not choose the source contract's disabled sentinel");
      } else {
        if (field === 'customShaderGuard') {
          expect(finding.message).toContain('runWgpuCustomShaderGuards returns on == null when invoked directly');
          expect(finding.message).toContain(
            'an active pass, a usable material and shader key, and the resolved WGSL source',
          );
        } else {
          expect(finding.message).toContain('no matching prepared forward-light list exists');
          expect(finding.message).toContain('the input has excess punctual lights');
        }
        expect(finding.message).toContain('creates one runtime per WgpuRenderState');
        expect(finding.message).toContain(
          'already initializes both customShaderGuard and forwardLightSelectionGuard to null',
        );
        expect(finding.message).toContain('Each enable function overwrites its exact slot with one diagnostic closure');
        expect(finding.message).toContain('no path clears or replaces either installed guard');
        expect(finding.message).toContain(
          'Make both guard slots required fields with their exact callable type | null',
        );
        expect(finding.message).toContain('preserving the two existing null initializers');
        expect(finding.message).toContain('project the sole exact callable alternative');
        expect(finding.message).toContain('assignments, comparisons, and optional calls');
        expect(finding.message).toContain("does not choose the source contract's disabled sentinel");
      }
      expect(finding.message).toContain('logging dependencies remain shakeable');
      expect(finding.message).toContain('one named closed guard state and handle every arm explicitly');
      expect(finding.message).toContain('will not choose or collapse an absence sentinel');
      expect(finding.message).toContain('import or install a diagnostic guard');
      expect(finding.message).toContain('invoke or synthesize a callback');
      expect(finding.message).toContain('widen its callable signature');
      expect(finding.message).toContain('change the render-state or runtime owner, or add side storage');
    }
  });

  it('keeps unrelated guard slots generic and accepts one explicit runtime absence state', () => {
    const unrelated = [
      input(
        'packages/types/src/GlScene3DRuntime.ts',
        'interface OtherSceneRuntime { colorSpaceGuard?: (() => void) | null }',
      ),
      input(
        'packages/types/src/GlScene3DRuntime.ts',
        'interface GlScene3DRuntime { validationGuard?: (() => void) | null }',
      ),
      input(
        'packages/example/src/GlScene3DRuntime.ts',
        'interface GlScene3DRuntime { colorSpaceGuard?: (() => void) | null }',
      ),
      input('packages/types/src/GlScene3DRuntime.ts', 'interface GlScene3DRuntime { colorSpaceGuard?: object | null }'),
      input(
        'packages/types/src/WgpuScene3DRuntime.ts',
        'interface WgpuScene3DRuntime { deformGuard?: ((mesh: object) => void) | null }',
      ),
    ];
    const resolved = [
      input(
        'packages/types/src/GlScene3DRuntime.ts',
        `interface GlScene3DRuntime {
           colorSpaceGuard: (() => void) | null;
           customShaderGuard: ((state: object) => void) | null;
           deformGuard: ((mesh: object) => void) | null;
           forwardLightSelectionGuard: ((lights: object) => void) | null;
           pbrExtensionGuard: ((extensions: readonly object[]) => void) | null;
         }`,
      ),
      input(
        'packages/types/src/WgpuScene3DRuntime.ts',
        `interface WgpuScene3DRuntime {
           customShaderGuard: ((state: object) => void) | null;
           forwardLightSelectionGuard: ((lights: object) => void) | null;
         }`,
      ),
      input('packages/types/src/GlScene3DRuntime.ts', 'interface GlScene3DRuntime { colorSpaceGuard?: () => void }'),
    ];

    expect(analyzeTypeScriptSourcePortability(resolved).findings).toEqual([]);
    for (const control of unrelated) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('combines an optional property with null');
      expect(findings[0]?.message).not.toContain('opt-in GL Scene3D diagnostic guard slot');
      expect(findings[0]?.message).not.toContain('opt-in WebGPU Scene3D diagnostic guard slot');
    }
  });

  it('separates lazy GlMeshProgram location caches from collapsed skin-sampler absence', () => {
    const source = input(
      'packages/types/src/GlMeshProgram.ts',
      `interface GlMeshProgram {
         locAlphaIsCoverage?: WebGLUniformLocation | null;
         locColorBias?: WebGLUniformLocation | null;
         locColorMatrix0?: WebGLUniformLocation | null;
         locColorMatrix1?: WebGLUniformLocation | null;
         locColorMatrix2?: WebGLUniformLocation | null;
         locColorMatrix3?: WebGLUniformLocation | null;
         locColorMatrixOffset?: WebGLUniformLocation | null;
         locColorScale?: WebGLUniformLocation | null;
         locInstanceColorPalette?: WebGLUniformLocation | null;
         locInstancePalette?: WebGLUniformLocation | null;
         locJointNormalTexture?: WebGLUniformLocation | null;
         locJointTexture?: WebGLUniformLocation | null;
         locObjectAlpha?: WebGLUniformLocation | null;
         locUvTransform?: WebGLUniformLocation | null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;
    const skinFields = new Set(['locJointNormalTexture', 'locJointTexture']);
    const lazyFields = new Set([
      'locAlphaIsCoverage',
      'locColorBias',
      'locColorMatrix0',
      'locColorMatrix1',
      'locColorMatrix2',
      'locColorMatrix3',
      'locColorMatrixOffset',
      'locColorScale',
      'locInstanceColorPalette',
      'locInstancePalette',
      'locObjectAlpha',
      'locUvTransform',
    ]);

    expect(findings).toHaveLength(14);
    expect(findings.every((finding) => finding.rule === 'mixed-absence')).toBe(true);
    for (const finding of findings) {
      const field = finding.subject.slice(finding.subject.lastIndexOf(':') + 1);
      if (skinFields.has(field)) {
        expect(finding.message).toContain(`gives the construction-time skin-sampler location ${field}`);
        expect(finding.message).toContain('the represented program has one unusable state');
        expect(finding.message).toContain('Classic, Debug, Matcap, PBR, Shaded, Toon, Unlit, and Wireframe factories');
        expect(finding.message).toContain('compileShadowDepthSkinnedProgram assign both joint sampler lookups');
        expect(finding.message).toContain(
          'compileGlCustomShaderProgram, compileShadowDepthProgram, and compileShadowDepthInstancedProgram omit both slots',
        );
        expect(finding.message).toContain('no later path resolves either one');
        if (field === 'locJointTexture') {
          expect(finding.message).toContain('requires locJointTexture != null together with jointMatrices');
          expect(finding.message).toContain('passes locJointTexture ?? null to uniform1i');
        } else {
          expect(finding.message).toContain('requires locJointNormalTexture != null together with normalMatrices');
          expect(finding.message).toContain('the shadow path never consumes this slot');
        }
        expect(finding.message).toContain(
          'Make locJointTexture and locJointNormalTexture required WebGLUniformLocation | null fields',
        );
        expect(finding.message).toContain('initialize both to null in the three factories that currently omit them');
        expect(finding.message).toContain('one named closed skin-program capability');
        expect(finding.message).toContain('C++ backend can preserve the current null and undefined tags');
        expect(finding.message).toContain('does not make the duplicate unusable sentinel a source contract');
        expect(finding.message).toContain('will not choose or collapse an absence sentinel');
        expect(finding.message).toContain('query or bind a GL uniform');
        expect(finding.message).toContain('infer whether a program supports skinning');
        expect(finding.message).toContain('coordinate the pose and normal samplers');
        continue;
      }

      expect(lazyFields.has(field)).toBe(true);
      expect(finding.message).toContain(`gives the lazy GL uniform-location cache ${field} three observed states`);
      expect(finding.message).toContain('undefined means unresolved');
      expect(finding.message).toContain(
        'null means getUniformLocation already proved the linked program omits the uniform',
      );
      expect(finding.message).toContain('WebGLUniformLocation means present');
      expect(finding.message).toContain('Preserve that query-once contract');
      expect(finding.message).toContain('Do not collapse undefined to null, which would skip the first query');
      expect(finding.message).toContain('null to undefined, which would repeat the query');
      expect(finding.message).toContain('C++ backend already represents all three tags');
      expect(finding.message).toContain('strict undefined/null probes without Any, casts, or side storage');
      expect(finding.message).toContain('no compiler lowering change is warranted');
      expect(finding.message).toContain("does not replace the source's named cache state");
      expect(finding.message).toContain('will preserve authored states but will not query GL');
      expect(finding.message).toContain('choose or collapse a sentinel');
      expect(finding.message).toContain('coordinate related cache fields');
      expect(finding.message).toContain('reinterpret or cast a location, or add side storage');
      if (field.startsWith('locColorMatrix')) {
        expect(finding.message).toContain('Every program factory omits all five color-matrix slots');
        expect(finding.message).toContain('queries all five locations together');
        expect(finding.message).toContain('shader-family all-or-none invariant');
        expect(finding.message).toContain('named GlColorMatrixUniformCache');
        expect(finding.message).toContain('present arm carries all five locations');
        expect(finding.message).toContain('only when the entire lookup group is present');
      } else if (field === 'locColorScale' || field === 'locColorBias') {
        expect(finding.message).toContain('Every program factory omits both color scale/bias slots');
        expect(finding.message).toContain('queries and caches locColorScale and locColorBias together');
        expect(finding.message).toContain('named GlColorScaleBiasUniformCache');
        expect(finding.message).toContain('present arm carries both locations');
      } else if (field === 'locObjectAlpha' || field === 'locAlphaIsCoverage') {
        expect(finding.message).toContain(`Every program factory omits ${field}`);
        expect(finding.message).toContain('resolves the object-alpha and alpha-coverage slots independently');
        expect(finding.message).toContain(`queries ${field} only while undefined`);
        expect(finding.message).toContain(`named GlUniformLocationCache for ${field}`);
      } else if (field === 'locInstancePalette') {
        expect(finding.message).toContain('Forward program factories omit locInstancePalette');
        expect(finding.message).toContain('compileShadowDepthInstancedProgram eagerly stores its exact lookup result');
        expect(finding.message).toContain('bindGlInstancePalette queries only an omitted undefined slot');
        expect(finding.message).toContain('allowing the shadow factory to construct either resolved arm directly');
      } else if (field === 'locInstanceColorPalette') {
        expect(finding.message).toContain('Every program factory omits locInstanceColorPalette');
        expect(finding.message).toContain('bindGlInstanceColorPalette queries it only while undefined');
      } else {
        expect(finding.message).toContain('Every program factory omits locUvTransform');
        expect(finding.message).toContain('bindGlUvTransform queries it only while undefined');
        expect(finding.message).toContain('a null texture is a separate per-bind no-op');
      }
    }
  });

  it('keeps unrelated uniform locations generic and accepts explicit GlMeshProgram cache states', () => {
    const resolved = input(
      'packages/types/src/GlMeshProgram.ts',
      `type UniformLocationCache =
         | { readonly state: 'unresolved' }
         | { readonly state: 'absent' }
         | { readonly location: WebGLUniformLocation; readonly state: 'present' };
       interface GlMeshProgram {
         locJointNormalTexture: WebGLUniformLocation | null;
         locJointTexture?: WebGLUniformLocation;
         locObjectAlpha: UniformLocationCache;
       }`,
    );
    const unrelated = [
      input(
        'packages/types/src/GlMeshProgram.ts',
        'interface OtherProgram { locObjectAlpha?: WebGLUniformLocation | null }',
      ),
      input(
        'packages/example/src/GlMeshProgram.ts',
        'interface GlMeshProgram { locObjectAlpha?: WebGLUniformLocation | null }',
      ),
      input(
        'packages/types/src/GlMeshProgram.ts',
        'interface GlMeshProgram { locMaterialAlpha?: WebGLUniformLocation | null }',
      ),
      input(
        'packages/types/src/GlMeshProgram.ts',
        'interface GlMeshProgram { locObjectAlpha?: OtherUniformLocation | null }',
      ),
    ];

    expect(analyzeTypeScriptSourcePortability([resolved]).findings).toEqual([]);
    for (const control of unrelated) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('combines an optional property with null');
      expect(findings[0]?.message).not.toContain('lazy GL uniform-location cache');
      expect(findings[0]?.message).not.toContain('eager skin-sampler location');
    }
  });

  it('explains the required nullable contract for GL render-pass tracking slots', () => {
    const source = input(
      'packages/types/src/GlRenderState.ts',
      `interface GlCubeRenderTarget { readonly cube: true }
       interface GlRenderTarget { readonly width: number }
       interface GlScissorRect { readonly height: number; readonly width: number; readonly x: number; readonly y: number }
       interface GlRenderStateRuntime {
         currentScissorRect?: GlScissorRect | null;
         currentRenderTarget?: GlCubeRenderTarget | GlRenderTarget | null;
       }
       interface SavedGlPassState {
         renderTarget: GlCubeRenderTarget | GlRenderTarget | null;
         scissorRect: GlScissorRect | null;
       }
       function createGlRenderStateRuntime(): GlRenderStateRuntime {
         const runtime = {} as GlRenderStateRuntime;
         runtime.currentRenderTarget = null;
         return runtime;
       }
       function initializeGlRenderState(runtime: GlRenderStateRuntime): void {
         runtime.currentScissorRect = null;
       }
       function saveGlPassState(runtime: Readonly<GlRenderStateRuntime>): SavedGlPassState {
         return {
           renderTarget: runtime.currentRenderTarget ?? null,
           scissorRect: runtime.currentScissorRect ?? null,
         };
       }
       function restoreGlPassState(runtime: GlRenderStateRuntime, saved: Readonly<SavedGlPassState>): void {
         runtime.currentRenderTarget = saved.renderTarget;
         runtime.currentScissorRect = saved.scissorRect;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      {
        rule: 'mixed-absence',
        subject: 'interface:GlRenderStateRuntime/property:currentRenderTarget',
      },
      {
        rule: 'mixed-absence',
        subject: 'interface:GlRenderStateRuntime/property:currentScissorRect',
      },
    ]);
    for (const [index, finding] of findings.entries()) {
      const field = ['currentRenderTarget', 'currentScissorRect'][index];
      expect(finding.message).toContain(
        `gives the active GL render-pass tracking slot ${field} both omission and explicit null`,
      );
      expect(finding.message).toContain('the represented runtime has one outside-pass or inactive state');
      expect(finding.message).toContain(
        'createGlRenderStateRuntime already assigns runtime.currentRenderTarget = null',
      );
      expect(finding.message).toContain(
        '_createGlRenderStateFromContext and test helpers assign runtime.currentScissorRect = null',
      );
      expect(finding.message).toContain('saveGlPassState normalizes both slots with ?? null');
      expect(finding.message).toContain('restoreGlPassState, GL state brackets, and cube-face passes save and restore');
      expect(finding.message).toContain('beginGlRenderPass writes the current target and active scissor together');
      expect(finding.message).toContain('invalidateGlRenderStateCache clears the tracked scissor to null');
      expect(finding.message).toContain('consumers use == null or ?? null before target and scissor work');
      expect(finding.message).toContain(
        'Make currentRenderTarget a required GlCubeRenderTarget | GlRenderTarget | null field',
      );
      expect(finding.message).toContain('currentScissorRect a required GlScissorRect | null field');
      expect(finding.message).toContain('initialize both in createGlRenderStateRuntime');
      expect(finding.message).toContain('preserve the direct pass save and restore assignments');
      expect(finding.message).toContain('analogous Canvas and WebGPU pass-state slots are already required nullable');
      expect(finding.message).toContain('model that as a closed runtime or pass state');
      expect(finding.message).toContain('will not choose or collapse an absence sentinel');
      expect(finding.message).toContain('infer a render target or scissor rectangle');
      expect(finding.message).toContain('bind or clear a framebuffer');
      expect(finding.message).toContain('alter the pass or clip stack');
      expect(finding.message).toContain('copy or materialize a target or rectangle, or add side storage');
    }
  });

  it('keeps unrelated pass slots generic and accepts required GL pass tracking', () => {
    const unrelated = [
      input(
        'packages/types/src/GlRenderState.ts',
        `interface GlCubeRenderTarget {}
         interface GlRenderTarget {}
         interface OtherGlRuntime { currentRenderTarget?: GlCubeRenderTarget | GlRenderTarget | null }`,
      ),
      input(
        'packages/types/src/GlRenderState.ts',
        'interface GlScissorRect {} interface GlRenderStateRuntime { savedScissorRect?: GlScissorRect | null }',
      ),
      input(
        'packages/example/src/GlRenderState.ts',
        'interface GlScissorRect {} interface GlRenderStateRuntime { currentScissorRect?: GlScissorRect | null }',
      ),
      input(
        'packages/types/src/GlRenderState.ts',
        'interface GlRenderTarget {} interface GlRenderStateRuntime { currentRenderTarget?: GlRenderTarget | null }',
      ),
      input(
        'packages/types/src/GlRenderState.ts',
        'interface WgpuScissorRect {} interface GlRenderStateRuntime { currentScissorRect?: WgpuScissorRect | null }',
      ),
      input(
        'packages/types/src/GlRenderState.ts',
        `interface GlCubeRenderTarget {}
         interface GlRenderTarget {}
         interface OtherTarget {}
         interface GlRenderStateRuntime {
           currentRenderTarget?: GlCubeRenderTarget | GlRenderTarget | OtherTarget | null;
         }`,
      ),
    ];
    const resolved = input(
      'packages/types/src/GlRenderState.ts',
      `interface GlCubeRenderTarget {}
       interface GlRenderTarget {}
       interface GlScissorRect {}
       interface GlRenderStateRuntime {
         currentRenderTarget: GlCubeRenderTarget | GlRenderTarget | null;
         currentScissorRect: GlScissorRect | null;
       }`,
    );
    const omitted = input(
      'packages/types/src/GlRenderState.ts',
      `interface GlCubeRenderTarget {}
       interface GlRenderTarget {}
       interface GlScissorRect {}
       interface GlRenderStateRuntime {
         currentRenderTarget?: GlCubeRenderTarget | GlRenderTarget;
         currentScissorRect?: GlScissorRect;
       }`,
    );

    expect(analyzeTypeScriptSourcePortability([resolved, omitted]).findings).toEqual([]);
    for (const control of unrelated) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('combines an optional property with null');
      expect(findings[0]?.message).not.toContain('active GL render-pass tracking slot');
    }
  });

  it('explains required nullable contracts for GL runtime seams and uniform color scratch', () => {
    const source = input(
      'packages/types/src/GlRenderState.ts',
      `interface GlRenderState {}
       interface ColorScaleBias { readonly scale: number }
       interface TintMaterialData { readonly tint: number }
       type GlRenderTextureGuard = (state: GlRenderState) => void;
       interface GlRenderStateRuntime {
         flushPendingDraws?: ((state: GlRenderState) => void) | null;
         glRenderTextureGuard?: GlRenderTextureGuard | null;
         quadBatchWriterUniformColorScaleBias?: ColorScaleBias | TintMaterialData | readonly number[] | null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      ['flushPendingDraws', 'glRenderTextureGuard', 'quadBatchWriterUniformColorScaleBias'].map((field) => ({
        rule: 'mixed-absence',
        subject: `interface:GlRenderStateRuntime/property:${field}`,
      })),
    );
    const byField = new Map(findings.map((finding) => [finding.subject.split(':').at(-1), finding.message]));

    const flush = byField.get('flushPendingDraws')!;
    expect(flush).toContain('lazily installed GL pending-draw seam both omission and explicit null');
    expect(flush).toContain('one uninstalled state');
    expect(flush).toContain('_createGlRenderStateFromContext and the GL test helpers initialize');
    expect(flush).toContain('createGlRenderStateRuntime is the exported construction path that still omits it');
    expect(flush).toContain('prepareGlQuadBatchWrite installs the exact flushGlQuadBatchWriter callback');
    expect(flush).toContain('beginGlCubeRenderFace and pushGlRenderState optional-call the slot');
    expect(flush).toContain('required ((state: GlRenderState) => void) | null field');
    expect(flush).toContain('initialize it to null in createGlRenderStateRuntime');
    expect(flush).toContain('does not import or install scene2d-gl');
    expect(flush).toContain('will not choose or collapse an absence sentinel');
    expect(flush).toContain('reorder a flush around GL state capture');

    const guard = byField.get('glRenderTextureGuard')!;
    expect(guard).toContain('opt-in GL render-texture diagnostic guard both omission and explicit null');
    expect(guard).toContain('one disabled state');
    expect(guard).toContain('createGlRenderStateRuntime currently omits the slot');
    expect(guard).toContain('setGlRenderTextureGuard overwrites it with the exact guard or null');
    expect(guard).toContain('enableGlRenderTextureGuards installs the warning guard');
    expect(guard).toContain('render-texture notification optional-calls the slot');
    expect(guard).toContain('required GlRenderTextureGuard | null field');
    expect(guard).toContain('initialize it to null in createGlRenderStateRuntime');
    expect(guard).toContain('logger and warning implementation remain shakeable');
    expect(guard).toContain('will not choose or collapse an absence sentinel');
    expect(guard).toContain('change render-texture publication');

    const uniform = byField.get('quadBatchWriterUniformColorScaleBias')!;
    expect(uniform).toContain("GL quad batch's uniform color-adjustment scratch slot both omission and explicit null");
    expect(uniform).toContain('its mode field is the authority');
    expect(uniform).toContain('registerGlColorAdjustmentMaterialFeature initializes the mode on opt-in');
    expect(uniform).toContain('recordGlColorAdjustment normalizes an absent mode to NONE');
    expect(uniform).toContain('writes the exact ColorScaleBias, TintMaterialData, or readonly number[] owner');
    expect(uniform).toContain('flushGlColorAdjustmentMaterialFeature returns before reading the slot in NONE mode');
    expect(uniform).toContain('clears it to null after capture');
    expect(uniform).toContain('required ColorScaleBias | TintMaterialData | readonly number[] | null field');
    expect(uniform).toContain('initialize it to null in createGlRenderStateRuntime');
    expect(uniform).toContain('preserve the mode as the state-machine discriminant');
    expect(uniform).toContain('does not register the color-adjustment feature');
    expect(uniform).toContain('will not choose or collapse an absence sentinel');
    expect(uniform).toContain('copy or materialize adjustment data');
  });

  it('keeps unrelated GL runtime slots generic and accepts one absence representation', () => {
    const unrelated = [
      input(
        'packages/types/src/GlRenderState.ts',
        'interface GlRenderState {} interface OtherGlRuntime { flushPendingDraws?: ((state: GlRenderState) => void) | null }',
      ),
      input(
        'packages/example/src/GlRenderState.ts',
        'interface GlRenderTextureGuard {} interface GlRenderStateRuntime { glRenderTextureGuard?: GlRenderTextureGuard | null }',
      ),
      input(
        'packages/types/src/GlRenderState.ts',
        `interface ColorScaleBias {}
         interface TintMaterialData {}
         interface GlRenderStateRuntime {
           savedUniformColorScaleBias?: ColorScaleBias | TintMaterialData | readonly number[] | null;
         }`,
      ),
      input(
        'packages/types/src/GlRenderState.ts',
        `interface ColorScaleBias {}
         interface GlRenderStateRuntime {
           quadBatchWriterUniformColorScaleBias?: ColorScaleBias | readonly number[] | null;
         }`,
      ),
    ];
    const resolved = input(
      'packages/types/src/GlRenderState.ts',
      `interface GlRenderState {}
       interface ColorScaleBias {}
       interface TintMaterialData {}
       interface GlRenderTextureGuard {}
       interface GlRenderStateRuntime {
         flushPendingDraws: ((state: GlRenderState) => void) | null;
         glRenderTextureGuard: GlRenderTextureGuard | null;
         quadBatchWriterUniformColorScaleBias: ColorScaleBias | TintMaterialData | readonly number[] | null;
       }`,
    );
    const omitted = input(
      'packages/types/src/GlRenderState.ts',
      `interface GlRenderState {}
       interface ColorScaleBias {}
       interface TintMaterialData {}
       interface GlRenderTextureGuard {}
       interface GlRenderStateRuntime {
         flushPendingDraws?: (state: GlRenderState) => void;
         glRenderTextureGuard?: GlRenderTextureGuard;
         quadBatchWriterUniformColorScaleBias?: ColorScaleBias | TintMaterialData | readonly number[];
       }`,
    );

    expect(analyzeTypeScriptSourcePortability([resolved, omitted]).findings).toEqual([]);
    for (const control of unrelated) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('combines an optional property with null');
      expect(findings[0]?.message).not.toContain('pending-draw seam');
      expect(findings[0]?.message).not.toContain('render-texture diagnostic guard');
      expect(findings[0]?.message).not.toContain('uniform color-adjustment scratch slot');
    }
  });

  it('traces WebGPU runtime inactive scratch and dead cache fields to exact remedies', () => {
    const source = input(
      'packages/types/src/WgpuRenderState.ts',
      `interface WgpuRenderState {}
       interface ColorScaleBias { readonly scale: number }
       interface TintMaterialData { readonly tint: number }
       type WgpuRenderTextureGuard = (state: WgpuRenderState) => void;
       interface WgpuRenderStateRuntime {
         wgpuRenderTextureGuard?: WgpuRenderTextureGuard | null;
         quadBatchWriterUniformColorScaleBias?: ColorScaleBias | TintMaterialData | readonly number[] | null;
         sceneMeshUploadCache?: WeakMap<object, object> | null;
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      ['quadBatchWriterUniformColorScaleBias', 'sceneMeshUploadCache', 'wgpuRenderTextureGuard'].map((field) => ({
        rule: 'mixed-absence',
        subject: `interface:WgpuRenderStateRuntime/property:${field}`,
      })),
    );
    const byField = new Map(findings.map((finding) => [finding.subject.split(':').at(-1), finding.message]));

    const guard = byField.get('wgpuRenderTextureGuard')!;
    expect(guard).toContain('opt-in WebGPU render-texture diagnostic guard both omission and explicit null');
    expect(guard).toContain('one disabled state');
    expect(guard).toContain('createWgpuRenderStateRuntimeInternal currently omits the slot');
    expect(guard).toContain("createWgpuOffscreenRenderState copies the source runtime's exact guard value");
    expect(guard).toContain('setWgpuRenderTextureGuard overwrites it with the exact guard or null');
    expect(guard).toContain('render-texture notification optional-calls it');
    expect(guard).toContain('required WgpuRenderTextureGuard | null field');
    expect(guard).toContain('initialize it to null in createWgpuRenderStateRuntimeInternal');
    expect(guard).toContain('retain the derived-state copy, nullable setter, and optional call');
    expect(guard).toContain('changes no render-texture publication behavior');
    expect(guard).toContain('will not choose or collapse an absence sentinel');
    expect(guard).toContain('change derived-state policy inheritance');

    const uniform = byField.get('quadBatchWriterUniformColorScaleBias')!;
    expect(uniform).toContain("WebGPU quad batch's uniform color-adjustment scratch slot");
    expect(uniform).toContain('quadBatchWriterColorScaleBiasMode is the authority');
    expect(uniform).toContain('createWgpuRenderStateRuntimeInternal omits the slot');
    expect(uniform).toContain('registerWgpuColorAdjustmentMaterialFeature initializes only the mode');
    expect(uniform).toContain('recordWgpuColorAdjustment normalizes an absent mode to NONE');
    expect(uniform).toContain('writes the exact ColorScaleBias, TintMaterialData, or readonly number[] owner');
    expect(uniform).toContain('otherwise promotes directly without requiring a stored uniform');
    expect(uniform).toContain('returns before reading it in NONE mode');
    expect(uniform).toContain('uses the mode proof before its non-null read in UNIFORM mode');
    expect(uniform).toContain('clears it to null after every non-empty flush');
    expect(uniform).toContain('required ColorScaleBias | TintMaterialData | readonly number[] | null field');
    expect(uniform).toContain('initialize it to null in createWgpuRenderStateRuntimeInternal');
    expect(uniform).toContain('does not register the feature, import its scene2d-wgpu implementation');
    expect(uniform).toContain('one named closed state whose uniform arm owns the exact adjustment value');
    expect(uniform).toContain('will not choose or collapse an absence sentinel');
    expect(uniform).toContain('copy or materialize adjustment data');

    const cache = byField.get('sceneMeshUploadCache')!;
    expect(cache).toContain('optional-null state-local scene mesh upload cache');
    expect(cache).toContain('no producer or consumer reads or writes this WgpuRenderStateRuntime field');
    expect(cache).toContain('stateRuntime.context.sceneMeshUploadCache on WgpuDeviceRuntime');
    expect(cache).toContain('every derived render state shares that same device-tier context');
    expect(cache).toContain('analogous GL accessor likewise uses its context-tier slot');
    expect(cache).toContain('Remove sceneMeshUploadCache from WgpuRenderStateRuntime');
    expect(cache).toContain('Keep the separately declared WgpuDeviceRuntime slot');
    expect(cache).toContain('give it a distinct name, owner, initialization path, teardown policy, and consumers');
    expect(cache).toContain('does not make an unread duplicate field meaningful');
    expect(cache).toContain('will not choose or collapse an absence sentinel');
    expect(cache).toContain('infer which ownership tier was intended');
    expect(cache).toContain('erase object keys or values through Any');
  });

  it('keeps unrelated WebGPU runtime slots generic and accepts the exact remedies', () => {
    const unrelated = [
      input(
        'packages/types/src/WgpuRenderState.ts',
        'interface WgpuRenderTextureGuard {} interface OtherWgpuRuntime { wgpuRenderTextureGuard?: WgpuRenderTextureGuard | null }',
      ),
      input(
        'packages/example/src/WgpuRenderState.ts',
        'interface WgpuRenderTextureGuard {} interface WgpuRenderStateRuntime { wgpuRenderTextureGuard?: WgpuRenderTextureGuard | null }',
      ),
      input(
        'packages/types/src/WgpuRenderState.ts',
        `interface ColorScaleBias {}
         interface WgpuRenderStateRuntime {
           savedUniformColorScaleBias?: ColorScaleBias | readonly number[] | null;
         }`,
      ),
      input(
        'packages/types/src/WgpuRenderState.ts',
        'interface WgpuRenderStateRuntime { sceneMeshUploadCache?: WeakMap<string, object> | null }',
      ),
    ];
    const resolved = input(
      'packages/types/src/WgpuRenderState.ts',
      `interface ColorScaleBias {}
       interface TintMaterialData {}
       interface WgpuRenderTextureGuard {}
       interface WgpuRenderStateRuntime {
         wgpuRenderTextureGuard: WgpuRenderTextureGuard | null;
         quadBatchWriterUniformColorScaleBias: ColorScaleBias | TintMaterialData | readonly number[] | null;
       }`,
    );
    const omitted = input(
      'packages/types/src/WgpuRenderState.ts',
      `interface ColorScaleBias {}
       interface TintMaterialData {}
       interface WgpuRenderTextureGuard {}
       interface WgpuRenderStateRuntime {
         wgpuRenderTextureGuard?: WgpuRenderTextureGuard;
         quadBatchWriterUniformColorScaleBias?: ColorScaleBias | TintMaterialData | readonly number[];
         sceneMeshUploadCache?: WeakMap<object, object>;
       }`,
    );

    expect(analyzeTypeScriptSourcePortability([resolved, omitted]).findings).toEqual([]);
    for (const control of unrelated) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('combines an optional property with null');
      expect(findings[0]?.message).not.toContain('WebGPU render-texture diagnostic guard');
      expect(findings[0]?.message).not.toContain("WebGPU quad batch's uniform color-adjustment scratch slot");
      expect(findings[0]?.message).not.toContain('state-local scene mesh upload cache');
    }
  });

  it('explains normalized optional-null string inputs at their required-nullable boundaries', () => {
    const gltf = input(
      'packages/types/src/GltfExtension.ts',
      `interface GltfImportOptions { basePath?: string | null }
       interface ImageResourceReference { basePath: string | null; uri: string }
       function createExternalImageResourceReference(uri: string, basePath: string | null): ImageResourceReference {
         return { basePath, uri };
       }
       function buildGltfImageResourceReference(
         uri: string,
         options: Readonly<GltfImportOptions> | undefined,
       ): ImageResourceReference {
         return createExternalImageResourceReference(uri, options?.basePath ?? null);
       }`,
    );
    const scene2D = input(
      'packages/types/src/Scene2DResources.ts',
      `interface Scene2DDocumentImportContext { mimeType: string | null; url: string | null }
       interface Scene2DDocumentLoadOptions { mimeType?: string | null }
       function loadScene2DDocumentFromUrl(
         url: string,
         options?: Readonly<Scene2DDocumentLoadOptions>,
       ): Scene2DDocumentImportContext {
         return { mimeType: options?.mimeType ?? null, url };
       }`,
    );
    const textInput = input(
      'packages/types/src/TextInputEditingOptions.ts',
      `interface ReplaceTextInputOptions { mergeKind?: string | null }
       interface TextInputHistoryEntry { mergeKind: string | null }
       function replaceTextInputRange(
         options?: Readonly<ReplaceTextInputOptions>,
       ): TextInputHistoryEntry {
         const mergeKind = options?.mergeKind ?? null;
         if (mergeKind !== null) void mergeKind.length;
         return { mergeKind };
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([gltf, scene2D, textInput]).findings;
    const expected = [
      {
        boundary:
          'buildGltfImageResourceReference passes options?.basePath ?? null to createExternalImageResourceReference',
        destination: 'ImageResourceReference.basePath',
        field: 'basePath',
        owner: 'GltfImportOptions',
        presentMeaning: 'base path',
        subject: 'interface:GltfImportOptions/property:basePath',
      },
      {
        boundary:
          'loadScene2DDocumentFromUrl writes mimeType: options?.mimeType ?? null into the required nullable Scene2DDocumentImportContext',
        destination: 'Scene2DDocumentImportContext.mimeType',
        field: 'mimeType',
        owner: 'Scene2DDocumentLoadOptions',
        presentMeaning: 'MIME hint',
        subject: 'interface:Scene2DDocumentLoadOptions/property:mimeType',
      },
      {
        boundary:
          'replaceTextInputRange passes options?.mergeKind ?? null to recordTextInputEdit, whose required nullable parameter is stored in TextInputHistoryEntry',
        destination: 'recordTextInputEdit mergeKind and TextInputHistoryEntry.mergeKind',
        field: 'mergeKind',
        owner: 'ReplaceTextInputOptions',
        presentMeaning: 'merge tag',
        subject: 'interface:ReplaceTextInputOptions/property:mergeKind',
      },
    ];

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual(
      expected.map(({ subject }) => ({ rule: 'mixed-absence', subject })),
    );
    for (const [index, finding] of findings.entries()) {
      const target = expected[index]!;
      expect(finding.message).toContain(
        `gives the normalized string input ${target.owner}.${target.field} both omission and explicit null`,
      );
      expect(finding.message).toContain(target.boundary);
      expect(finding.message).toContain('That ?? null boundary makes the two absence spellings identical');
      expect(finding.message).toContain(`an empty string remains a present ${target.presentMeaning}`);
      expect(finding.message).toContain(`Keep ${target.destination} required nullable`);
      expect(finding.message).toContain(`declare ${target.owner}.${target.field} as an optional string`);
      expect(finding.message).toContain('omission is the sole input-side absence');
      expect(finding.message).toContain('one named closed input state and handle each arm explicitly');
      expect(finding.message).toContain('will not choose or collapse an absence sentinel');
      expect(finding.message).toContain('replace a present empty string with null or a default');
      expect(finding.message).toContain(`synthesize a replacement ${target.presentMeaning}`);
      expect(finding.message).toContain('rewrite the caller or downstream storage');
      expect(finding.message).toContain('reinterpret or cast the value');
      expect(finding.message).toContain('or add side storage');
    }
    expect(findings[1]!.message).toContain(
      'createScene2DDocumentFromBytes then passes that context unchanged to each registry matcher and the selected importer',
    );
    expect(findings[1]!.message).toContain(
      'Lottie, SVG, and SWF matchers compare only their exact MIME strings before falling back to byte sniffing',
    );
  });

  it('keeps unrelated string options generic and accepts one input absence state', () => {
    const optionalInputs = [
      input('packages/types/src/GltfExtension.ts', 'interface GltfImportOptions { basePath?: string }'),
      input('packages/types/src/Scene2DResources.ts', 'interface Scene2DDocumentLoadOptions { mimeType?: string }'),
      input(
        'packages/types/src/TextInputEditingOptions.ts',
        'interface ReplaceTextInputOptions { mergeKind?: string }',
      ),
    ];
    const requiredStorage = input(
      'NormalizedStringStorage.ts',
      `interface ImportContext { mimeType: string | null }
       interface ResourceReference { basePath: string | null }
       interface HistoryEntry { mergeKind: string | null }`,
    );
    const explicit = input(
      'ExplicitStringInput.ts',
      `type StringInput =
         | { readonly state: 'omitted' }
         | { readonly state: 'cleared' }
         | { readonly state: 'supplied'; readonly value: string };
       interface UpdateOptions { value: StringInput }`,
    );
    const unrelated = [
      input('packages/types/src/GltfExtension.ts', 'interface OtherGltfOptions { basePath?: string | null }'),
      input(
        'packages/types/src/Scene2DResources.ts',
        'interface Scene2DDocumentLoadOptions { contentType?: string | null }',
      ),
      input(
        'packages/example/src/TextInputEditingOptions.ts',
        'interface ReplaceTextInputOptions { mergeKind?: string | null }',
      ),
      input('packages/types/src/GltfExtension.ts', 'interface GltfImportOptions { basePath?: number | null }'),
    ];

    expect(analyzeTypeScriptSourcePortability([...optionalInputs, requiredStorage, explicit]).findings).toEqual([]);
    for (const control of unrelated) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('combines an optional property with null');
      expect(findings[0]?.message).not.toContain('normalized string input');
    }
  });

  it('explains the one-sentinel contract for the Scene2D audio platform decoder input', () => {
    const source = input(
      'packages/types/src/Scene2DResources.ts',
      `interface AudioContext { decodeAudioData(buffer: ArrayBuffer): Promise<object> }
       interface LoadScene2DAudioResourcesOptions { context?: AudioContext | null }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      {
        rule: 'mixed-absence',
        subject: 'interface:LoadScene2DAudioResourcesOptions/property:context',
      },
    ]);
    const message = findings[0]!.message;
    expect(message).toContain("one-shot Scene2D audio load's platform decoder context");
    expect(message).toContain('loadScene2DAudioResources immediately evaluates options?.context ?? null');
    expect(message).toContain('passes that required AudioContext | null unchanged to resolveAudioResourceReference');
    expect(message).toContain('External references resolve only through the fetch seam and never inspect the context');
    expect(message).toContain('Embedded references first try a registered MIME decoder');
    expect(message).toContain(
      'decodeAudioResourceBytes calls AudioContext.decodeAudioData only when no registered decoder',
    );
    expect(message).toContain('returns null when the normalized context is null');
    expect(message).toContain('disable only the platform decode fallback');
    expect(message).toContain(
      'a present AudioContext owner is borrowed unchanged for this operation and never retained',
    );
    expect(message).toContain('Declare LoadScene2DAudioResourcesOptions.context as optional AudioContext without null');
    expect(message).toContain('keep the required nullable resolver and decoder parameters');
    expect(message).toContain('named closed context-input state');
    expect(message).toContain('will not whitelist a redundant absence spelling');
    expect(message).toContain('construct, resume, or close an AudioContext');
    expect(message).toContain('select or invoke a decoder or fetcher');
    expect(message).toContain('copy or materialize the host context owner');
    expect(message).toContain('reinterpret or cast the context, or add side storage');
  });

  it('keeps unrelated audio context inputs generic and accepts one input absence state', () => {
    const controls = [
      input('Other.ts', 'interface LoadScene2DAudioResourcesOptions { context?: AudioContext | null }'),
      input('packages/types/src/Scene2DResources.ts', 'interface OtherOptions { context?: AudioContext | null }'),
      input(
        'packages/types/src/Scene2DResources.ts',
        'interface LoadScene2DAudioResourcesOptions { device?: AudioContext | null }',
      ),
      input(
        'packages/types/src/Scene2DResources.ts',
        'interface LoadScene2DAudioResourcesOptions { context?: OfflineAudioContext | null }',
      ),
    ];
    const resolved = [
      input(
        'packages/types/src/Scene2DResources.ts',
        'interface LoadScene2DAudioResourcesOptions { context?: AudioContext }',
      ),
      input('Downstream.ts', 'interface AudioResolverInput { context: AudioContext | null }'),
    ];

    expect(analyzeTypeScriptSourcePortability(resolved).findings).toEqual([]);
    for (const control of controls) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]!.message).toContain('combines an optional property with null');
      expect(findings[0]!.message).not.toContain('Scene2D audio load');
    }
  });

  it('explains the required nullable contract for FlightDocument node interaction metadata', () => {
    const source = input(
      'packages/types/src/FlightDocument.ts',
      `interface FlightDocumentInteractiveStates { readonly hover: object | null }
       interface FlightDocumentInteractiveStateTransitionDescriptor { readonly kind: string }
       interface FlightDocumentNode {
         children: FlightDocumentNode[];
         fields: Record<string, string>;
         interactiveStates?: FlightDocumentInteractiveStates | null;
         kind: string;
         transition?: FlightDocumentInteractiveStateTransitionDescriptor | null;
       }
       function readNode(): FlightDocumentNode {
         const children: FlightDocumentNode[] = [];
         const fields: Record<string, string> = {};
         const interactiveStates: FlightDocumentInteractiveStates | null = null;
         const kind = 'Node';
         const transition: FlightDocumentInteractiveStateTransitionDescriptor | null = null;
         return { children, fields, interactiveStates, kind, transition };
       }
       function readInteraction(node: Readonly<FlightDocumentNode>): void {
         if (node.interactiveStates == null) {
           if (node.transition != null) throw new TypeError('transition requires states');
           return;
         }
         const transition = node.transition ?? null;
         void transition;
       }
       function substituteNode(node: Readonly<FlightDocumentNode>): FlightDocumentNode {
         const children = node.children;
         const fields = node.fields;
         return { children, fields, kind: node.kind };
       }`,
    );
    const findings = analyzeTypeScriptSourcePortability([source]).findings;

    expect(findings.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      {
        rule: 'mixed-absence',
        subject: 'interface:FlightDocumentNode/property:interactiveStates',
      },
      {
        rule: 'mixed-absence',
        subject: 'interface:FlightDocumentNode/property:transition',
      },
    ]);
    for (const [index, finding] of findings.entries()) {
      const field = ['interactiveStates', 'transition'][index];
      expect(finding.message).toContain(
        `gives the persisted FlightDocument node interaction slot ${field} both omission and explicit null`,
      );
      expect(finding.message).toContain('the represented contract has one inactive state');
      expect(finding.message).toContain('transition is invalid without interactiveStates');
      expect(finding.message).toContain(
        'flightDocumentText.readNode returns { children, fields, interactiveStates, kind, transition }',
      );
      expect(finding.message).toContain(
        'the 2D and 3D scene writers assign both fields from readInteractiveStateBindingMetadata',
      );
      expect(finding.message).toContain('collapse undefined and null with == null, != null, or ?? null');
      expect(finding.message).toContain('substituteNode rebuilds { children, fields, kind }');
      expect(finding.message).toContain('optional storage can silently discard present interaction metadata');
      expect(finding.message).toContain(
        'Make interactiveStates and transition required nullable fields on FlightDocumentNode',
      );
      expect(finding.message).toContain('normalize omitted input syntax to null at ingress');
      expect(finding.message).toContain(
        'initialize or deliberately preserve both fields in every parser, writer, and reconstruction path',
      );
      expect(finding.message).toContain('a separate input shape or one named closed metadata state');
      expect(finding.message).toContain('will not choose or collapse an absence sentinel');
      expect(finding.message).toContain('infer a transition from interactive states');
      expect(finding.message).toContain('decide whether a transformation preserves or clears metadata');
      expect(finding.message).toContain('clone or materialize either metadata owner');
      expect(finding.message).toContain('route it through Any');
      expect(finding.message).toContain('reinterpret or cast it');
      expect(finding.message).toContain('or add side storage');
    }
  });

  it('keeps unrelated interaction metadata generic and accepts explicit FlightDocument node state', () => {
    const required = input(
      'packages/types/src/FlightDocument.ts',
      `interface FlightDocumentInteractiveStates { readonly hover: object | null }
       interface FlightDocumentInteractiveStateTransitionDescriptor { readonly kind: string }
       interface FlightDocumentNode {
         interactiveStates: FlightDocumentInteractiveStates | null;
         transition: FlightDocumentInteractiveStateTransitionDescriptor | null;
       }`,
    );
    const explicit = input(
      'FlightDocumentNodeState.ts',
      `interface FlightDocumentInteractiveStates { readonly hover: object | null }
       interface FlightDocumentInteractiveStateTransitionDescriptor { readonly kind: string }
       type FlightDocumentNodeInteraction =
         | { readonly state: 'inactive' }
         | {
             readonly interactiveStates: FlightDocumentInteractiveStates;
             readonly state: 'interactive';
             readonly transition: FlightDocumentInteractiveStateTransitionDescriptor | null;
           };
       interface FlightDocumentNode { interaction: FlightDocumentNodeInteraction }`,
    );
    const unrelatedOwner = input(
      'packages/types/src/FlightDocument.ts',
      `interface FlightDocumentInteractiveStates { readonly hover: object | null }
       interface FlightDocumentInteractiveStateTransitionDescriptor { readonly kind: string }
       interface DocumentNodeDraft {
         interactiveStates?: FlightDocumentInteractiveStates | null;
         transition?: FlightDocumentInteractiveStateTransitionDescriptor | null;
       }`,
    );
    const unrelatedLocation = input(
      'packages/example/src/FlightDocument.ts',
      `interface FlightDocumentInteractiveStates { readonly hover: object | null }
       interface FlightDocumentInteractiveStateTransitionDescriptor { readonly kind: string }
       interface FlightDocumentNode {
         interactiveStates?: FlightDocumentInteractiveStates | null;
         transition?: FlightDocumentInteractiveStateTransitionDescriptor | null;
       }`,
    );

    expect(analyzeTypeScriptSourcePortability([required, explicit]).findings).toEqual([]);
    for (const control of [unrelatedOwner, unrelatedLocation]) {
      const findings = analyzeTypeScriptSourcePortability([control]).findings;
      expect(findings).toHaveLength(2);
      expect(findings.every((finding) => finding.message.includes('combines an optional property with null'))).toBe(
        true,
      );
      expect(findings.every((finding) => !finding.message.includes('persisted FlightDocument node'))).toBe(true);
    }
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
