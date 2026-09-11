import type { CompilerLoweringFailureCode, CompilerLoweringPass, IrModule } from '../../compiler-types/src/index.js';
import {
  createCompilerLoweringFailure,
  isCompilerLoweringFailure,
  lowerIrModuleWithCompilerPasses,
} from './compilerLoweringPass.js';

describe('createCompilerLoweringFailure', () => {
  it('creates an inspectable pass-named failure with source identity and cause', () => {
    const cause = new Error('fixture cause');
    const failure = createCompilerLoweringFailure('malformed-ir', 'fixture-pass', module, 'invalid output', cause);

    expect(failure).toMatchObject({
      cause,
      code: 'malformed-ir',
      kind: 'compiler-lowering',
      name: 'CompilerLoweringError',
      packageName: '@flighthq/math',
      pass: 'fixture-pass',
      source: 'src/value.ts',
    });
    expect(failure.message).toContain('fixture-pass failed for @flighthq/math/src/value.ts: invalid output');
  });
});

describe('isCompilerLoweringFailure', () => {
  it('accepts every stable code and rejects unknown or incomplete failures', () => {
    const codes: readonly CompilerLoweringFailureCode[] = [
      'duplicate-pass-name',
      'invalid-pass-identity',
      'invalid-pass-order',
      'invalid-verification-depth',
      'malformed-ir',
      'non-idempotent-pass',
      'pass-execution-failed',
      'unsupported-ir',
    ];

    expect(
      codes.every((code) => isCompilerLoweringFailure(createCompilerLoweringFailure(code, 'pass', module, code))),
    ).toBe(true);
    expect(isCompilerLoweringFailure(new Error('ordinary'))).toBe(false);
    expect(
      isCompilerLoweringFailure(
        Object.assign(new Error('unknown'), {
          code: 'unknown',
          kind: 'compiler-lowering',
          packageName: module.packageName,
          pass: 'pass',
          source: module.source,
        }),
      ),
    ).toBe(false);
    expect(
      isCompilerLoweringFailure(
        Object.assign(new Error('missing pass'), {
          code: 'malformed-ir',
          kind: 'compiler-lowering',
          packageName: module.packageName,
          source: module.source,
        }),
      ),
    ).toBe(false);
  });
});

describe('lowerIrModuleWithCompilerPasses', () => {
  it('applies declared ordering deterministically without changing caller-owned input', () => {
    const first = createImportPass('first', 'first');
    const second = createImportPass('second', 'second', ['first']);
    const snapshot = structuredClone(module);

    const output = lowerIrModuleWithCompilerPasses(module, [first, second]);

    expect(output.imports.map((item) => item.specifier)).toEqual(['first', 'second']);
    expect(lowerIrModuleWithCompilerPasses(module, [first, second])).toEqual(output);
    expect(module).toEqual(snapshot);
    expect(output).not.toBe(module);
  });

  it('treats an empty plan as an identity while returning independent data', () => {
    const output = lowerIrModuleWithCompilerPasses(module, []);

    expect(output).toEqual(module);
    expect(output).not.toBe(module);
    expect(output.imports).not.toBe(module.imports);
  });

  it('copies caller-owned input once and transfers owned outputs directly between passes', () => {
    let firstInput: Readonly<IrModule> | undefined;
    let firstOutput: IrModule | undefined;
    let firstVerificationInput: Readonly<IrModule> | undefined;
    let secondInput: Readonly<IrModule> | undefined;
    const first = createPass(
      'first',
      (value) => {
        firstInput = value;
        firstOutput = appendImport(value, 'first');
        return firstOutput;
      },
      (value) => {
        firstVerificationInput = value;
        return { kind: 'valid' };
      },
    );
    const second = createPass(
      'second',
      (value) => {
        secondInput = value;
        return appendImport(value, 'second');
      },
      () => ({ kind: 'valid' }),
      ['first'],
    );

    const output = lowerIrModuleWithCompilerPasses(module, [first, second]);

    expect(firstInput).not.toBe(module);
    expect(firstVerificationInput).toBe(firstOutput);
    expect(secondInput).toBe(firstOutput);
    expect(output.imports.map((item) => item.specifier)).toEqual(['first', 'second']);
  });

  it('refuses malformed input before an empty plan or selected pass can consume it', () => {
    let transforms = 0;
    const malformed = { ...module, name: '' };
    const pass = createPass('must-not-run', (value) => {
      transforms += 1;
      return structuredClone(value);
    });

    expectFailure(() => lowerIrModuleWithCompilerPasses(malformed, []), 'malformed-ir', 'lowering-plan');
    expectFailure(() => lowerIrModuleWithCompilerPasses(malformed, [pass]), 'malformed-ir', 'lowering-plan');
    expect(transforms).toBe(0);
  });

  it('allows a pass to declare that it is not idempotent', () => {
    const pass = createImportPass('non-idempotent', 'once', [], false);

    expect(lowerIrModuleWithCompilerPasses(module, [pass]).imports.map((item) => item.specifier)).toEqual(['once']);
    expect(
      lowerIrModuleWithCompilerPasses(module, [pass], { verificationDepth: 'idempotence' }).imports.map(
        (item) => item.specifier,
      ),
    ).toEqual(['once']);
  });

  it('runs one transform and postcondition ordinarily and repeats both only for explicit idempotence verification', () => {
    let postconditions = 0;
    let transforms = 0;
    const pass = createPass(
      'counted',
      (value) => {
        transforms += 1;
        return structuredClone(value);
      },
      () => {
        postconditions += 1;
        return { kind: 'valid' };
      },
    );

    lowerIrModuleWithCompilerPasses(module, [pass]);
    expect({ postconditions, transforms }).toEqual({ postconditions: 1, transforms: 1 });

    postconditions = 0;
    transforms = 0;
    lowerIrModuleWithCompilerPasses(module, [pass], { verificationDepth: 'idempotence' });
    expect({ postconditions, transforms }).toEqual({ postconditions: 2, transforms: 2 });
  });

  it('rejects invalid plans, structural or pass-specific malformation, changed identity, false idempotence, and errors', () => {
    let corruptProvenancePostconditions = 0;
    const first = createImportPass('first', 'first');
    const second = createImportPass('second', 'second', ['first']);
    expectFailure(() => lowerIrModuleWithCompilerPasses(module, [first, first]), 'duplicate-pass-name', 'first');
    expectFailure(
      () => lowerIrModuleWithCompilerPasses(module, [createImportPass('', 'empty')]),
      'invalid-pass-identity',
      '',
    );
    expectFailure(
      () => lowerIrModuleWithCompilerPasses(module, [createImportPass('dependent', 'value', [''])]),
      'invalid-pass-identity',
      'dependent',
    );
    expectFailure(
      () => lowerIrModuleWithCompilerPasses(module, [createImportPass('dependent', 'value', ['first', 'first'])]),
      'invalid-pass-identity',
      'dependent',
    );
    expectFailure(
      () =>
        lowerIrModuleWithCompilerPasses(module, [], {
          verificationDepth: 'unknown',
        } as unknown as Parameters<typeof lowerIrModuleWithCompilerPasses>[2]),
      'invalid-verification-depth',
      'lowering-plan',
    );
    expectFailure(() => lowerIrModuleWithCompilerPasses(module, [second, first]), 'invalid-pass-order', 'second');
    expectFailure(() => lowerIrModuleWithCompilerPasses(module, [second]), 'invalid-pass-order', 'second');
    expectFailure(
      () => lowerIrModuleWithCompilerPasses(module, [createImportPass('self', 'self', ['self'])]),
      'invalid-pass-order',
      'self',
    );
    expectFailure(
      () =>
        lowerIrModuleWithCompilerPasses(module, [
          createPass(
            'malformed',
            (value) => structuredClone(value),
            () => ({ kind: 'invalid', reason: 'bad IR' }),
          ),
        ]),
      'malformed-ir',
      'malformed',
    );
    expectFailure(
      () =>
        lowerIrModuleWithCompilerPasses(module, [
          createPass('structurally-malformed', (value) => ({ ...value, name: '' })),
        ]),
      'malformed-ir',
      'structurally-malformed',
    );
    for (const [passName, changedIdentity] of [
      ['changed-name', { name: 'changed' }],
      ['changed-package', { packageName: '@flighthq/changed' }],
      ['changed-source', { source: 'src/changed.ts' }],
    ] as const) {
      expectFailure(
        () =>
          lowerIrModuleWithCompilerPasses(module, [
            createPass(passName, (value) => ({ ...value, ...changedIdentity })),
          ]),
        'malformed-ir',
        passName,
      );
    }
    expectFailure(
      () =>
        lowerIrModuleWithCompilerPasses(moduleWithBinding, [
          createPass('corrupts-provenance', corruptModuleBindingFingerprint, () => {
            corruptProvenancePostconditions += 1;
            return { kind: 'valid' };
          }),
        ]),
      'malformed-ir',
      'corrupts-provenance',
    );
    expect(corruptProvenancePostconditions).toBe(0);
    expectFailure(
      () =>
        lowerIrModuleWithCompilerPasses(
          module,
          [createPass('claimed-idempotent', (value) => appendImport(value, 'again'))],
          { verificationDepth: 'idempotence' },
        ),
      'non-idempotent-pass',
      'claimed-idempotent',
    );
    for (const [passName, verification] of [
      ['verification-null', null],
      ['verification-nonobject', 'valid'],
      ['verification-no-kind', {}],
      ['verification-unknown-kind', { kind: 'unknown' }],
      ['verification-no-reason', { kind: 'invalid' }],
      ['verification-nonstring-reason', { kind: 'invalid', reason: 1 }],
      ['verification-empty-reason', { kind: 'invalid', reason: '' }],
    ] as const) {
      expectFailure(
        () =>
          lowerIrModuleWithCompilerPasses(module, [
            createPass(
              passName,
              (value) => structuredClone(value),
              (() => verification) as unknown as CompilerLoweringPass['verifyIrModule'],
            ),
          ]),
        'pass-execution-failed',
        passName,
      );
    }
    expectFailure(
      () =>
        lowerIrModuleWithCompilerPasses(module, [
          createPass('throws', () => {
            throw new Error('broken pass');
          }),
        ]),
      'pass-execution-failed',
      'throws',
    );
    expectFailure(
      () =>
        lowerIrModuleWithCompilerPasses(module, [
          createPass('throws-value', () => {
            const error: unknown = 'broken pass value';
            throw error;
          }),
        ]),
      'pass-execution-failed',
      'throws-value',
    );
  });
});

function appendImport(moduleValue: Readonly<IrModule>, specifier: string): IrModule {
  return { ...moduleValue, imports: [...moduleValue.imports, { bindings: [], specifier, typeOnly: false }] };
}

function createImportPass(
  name: string,
  specifier: string,
  runsAfter: readonly string[] = [],
  idempotent = true,
): CompilerLoweringPass {
  return createPass(
    name,
    (moduleValue) =>
      moduleValue.imports.some((item) => item.specifier === specifier)
        ? structuredClone(moduleValue)
        : appendImport(moduleValue, specifier),
    () => ({ kind: 'valid' }),
    runsAfter,
    idempotent,
  );
}

function createPass(
  name: string,
  lowerIrModule: CompilerLoweringPass['lowerIrModule'],
  verifyIrModule: CompilerLoweringPass['verifyIrModule'] = () => ({ kind: 'valid' }),
  runsAfter: readonly string[] = [],
  idempotent = true,
): CompilerLoweringPass {
  return { idempotent, lowerIrModule, name, runsAfter, verifyIrModule };
}

function corruptModuleBindingFingerprint(moduleValue: Readonly<IrModule>): IrModule {
  const declaration = moduleValue.declarations[0];
  if (declaration?.kind !== 'variable') throw new Error('Expected variable declaration fixture');
  if ('pattern' in declaration) throw new Error('Expected named variable declaration fixture');
  return {
    ...moduleValue,
    declarations: [
      {
        ...declaration,
        binding: { ...declaration.binding, fingerprint: 'sha256:invalid' },
      },
    ],
  };
}

function expectFailure(run: () => unknown, code: CompilerLoweringFailureCode, pass: string): void {
  try {
    run();
    throw new Error('Expected compiler lowering failure');
  } catch (error) {
    expect(isCompilerLoweringFailure(error)).toBe(true);
    expect(error).toMatchObject({ code, kind: 'compiler-lowering', pass });
  }
}

const module: IrModule = {
  declarations: [],
  exports: [],
  imports: [],
  name: 'value',
  packageName: '@flighthq/math',
  source: 'src/value.ts',
};

const moduleWithBinding: IrModule = {
  ...module,
  declarations: [
    {
      binding: {
        column: 1,
        fingerprint: `sha256:${'0'.repeat(64)}`,
        id: 'binding:value',
        kind: 'variable',
        line: 1,
        name: 'value',
        packageName: module.packageName,
        scope: 'module',
        source: module.source,
        space: 'value',
      },
      declarationKind: 'const',
      exported: true,
      kind: 'variable',
      mutable: false,
      origin: {
        column: 1,
        fingerprint: `sha256:${'0'.repeat(64)}`,
        line: 1,
        packageName: module.packageName,
        source: module.source,
      },
    },
  ],
};
