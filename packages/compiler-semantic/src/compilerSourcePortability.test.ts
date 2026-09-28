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

  it('keeps optional nullable callbacks as mixed absence until the API elects one state model', () => {
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

    // A callback-bearing Signal does not make the two implicit absence spellings one source contract. The
    // measured constructors write null, and every direct use collapses null and undefined with `== null`, so
    // making these properties required-nullable is the exact narrow source fix. The declaration nevertheless
    // exposes three distinguishable states to other consumers until it chooses that one sentinel (or names
    // all three states explicitly), so the gate must not infer the choice from current downstream uses.
    expect(analyzeTypeScriptSourcePortability([mixed]).findings).toMatchObject([
      {
        message:
          'interface:AnimationPlayer/property:onEvent combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:AnimationPlayer/property:onEvent',
      },
      {
        message:
          'interface:AnimationPlayer/property:onFinished combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:AnimationPlayer/property:onFinished',
      },
      {
        message:
          'interface:AnimationPlayer/property:onLooped combines an optional property with null; choose one absence representation or make all three states explicit.',
        rule: 'mixed-absence',
        subject: 'interface:AnimationPlayer/property:onLooped',
      },
    ]);
    expect(
      analyzeTypeScriptSourcePortability([optional, nullable, explicit]).findings.filter(
        (finding) => finding.rule === 'mixed-absence',
      ),
    ).toEqual([]);
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
