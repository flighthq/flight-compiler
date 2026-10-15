import { describe, expect, it } from 'vitest';

import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleCpp } from './cppCompilerBackend.js';

function emit(source: string): string {
  const sourceFile = ts.createSourceFile(
    '/flight/packages/math/src/readonly-union-views.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/math',
    upstreamDirectory: '/flight',
  });
  expect(result.diagnostics).toEqual([]);
  return emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;
}

describe('nominal union to readonly structural-view union conversion', () => {
  it('converts every nominal union arm to its exact readonly structural view', () => {
    const contents = emit(
      `interface Base { kind: string }
       interface First extends Base { first: number }
       interface Second extends Base { second: number }
       type Value = Base | First | Second;
       type ReadonlyValue = Readonly<Base> | Readonly<First> | Readonly<Second>;
       function read(value: ReadonlyValue): string { return value.kind; }
       export function readMutable(value: Value): string { return read(value); }`,
    );

    expect(contents).toContain('std::visit');
    expect(contents).toContain('std::is_same_v<contextual_union_value_type, flight::Ref<Base>>');
    expect(contents).toContain('std::is_same_v<contextual_union_value_type, flight::Ref<First>>');
    expect(contents).toContain('flight::StructuralRef<flight::RowReadonly<flight::RowOf<flight::Ref<Second>>>>');
  });
});
