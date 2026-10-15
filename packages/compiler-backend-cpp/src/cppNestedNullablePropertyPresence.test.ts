import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import type { CompilerModuleResolutionPlan, CppCompilerExternalBinding } from '../../compiler-types/src/index.js';
import { createCppCompilerBackend } from './cppCompilerBackend.js';

const moduleResolution: CompilerModuleResolutionPlan = {
  edges: [{ specifier: './body', target: { packageName: '@flighthq/types', source: 'packages/types/src/body.ts' } }],
  schema: 'flight-compiler-module-resolution/1',
};

// ArrayBufferView is the SDK payload arm that makes the narrowed property take the runtime-bound
// projection path. The property itself remains ordinary structural-row storage.
const bufferBindings: CppCompilerExternalBinding[] = [
  {
    headers: ['flight/array_buffer_view.hpp'],
    nullability: 'non-null',
    ownership: 'value',
    sourceName: 'ArrayBufferView',
    space: 'type',
    targetName: 'flight::ArrayBufferView',
  },
];

function emitConsumer(body: string): string {
  const source = (file: string, text: string) => ({
    packageName: '@flighthq/types',
    sourceFile: ts.createSourceFile(`/flight/packages/types/src/${file}`, text, ts.ScriptTarget.Latest, true),
    upstreamDirectory: '/flight',
  });
  const results = lowerTypeScriptSources(
    [
      source(
        'body.ts',
        `export type Body = string | ArrayBuffer | ArrayBufferView | null;
         export interface Request { method: string; body?: Body; alternate?: Body }
         export interface Envelope { request?: Request }`,
      ),
      source('consumer.ts', `import type { Body, Envelope, Request } from './body';\n${body}`),
    ],
    moduleResolution,
  );
  expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
  const session = createCppCompilerBackend().createEmissionSession!({
    moduleResolution,
    modules: results.map((result) => result.module),
    options: {
      externalBindings: { bindings: bufferBindings, schema: 'flight-cpp-external-bindings/1' },
      runtimeProfile: 'flight-cpp',
    },
  });
  const consumer = results.find((result) => result.module.source.endsWith('consumer.ts'))!;
  return session.emitModule(consumer.module)[0]!.contents;
}

function presenceTests(contents: string): string[] {
  return [...contents.matchAll(/const auto& presence_operand = ([^;]+); return ([^;]+);/gu)].map(
    (match) => `${match[1]!} => ${match[2]!}`,
  );
}

const requestBody = 'flight::row_get<flight::RowKey<"body">>(request)';

describe('C++ nested nullable optional property presence', () => {
  it('keeps the SDK request body on its storage after the undefined guard narrows its value', () => {
    const contents = emitConsumer(
      `export function hasBody(request: Readonly<Request>): boolean {
         return request.body !== undefined && request.body !== null;
       }`,
    );

    expect(presenceTests(contents)).toEqual([
      `${requestBody} => presence_operand.has_value()`,
      `${requestBody} => !presence_operand.has_value() || presence_operand.value().has_value()`,
    ]);
    expect(contents).not.toContain(`${requestBody}.value(); return`);
  });

  it('leaves an unguarded null test on the two-level storage', () => {
    const contents = emitConsumer(
      `export function hasBody(request: Readonly<Request>): boolean { return request.body !== null; }`,
    );

    expect(presenceTests(contents)).toEqual([
      `${requestBody} => !presence_operand.has_value() || presence_operand.value().has_value()`,
    ]);
  });

  it('evaluates a receiver once while testing its property storage', () => {
    const contents = emitConsumer(
      `export function loaded(load: () => Readonly<Request>): boolean { return load().body !== null; }`,
    );
    const tests = presenceTests(contents);

    expect(tests).toHaveLength(1);
    expect(tests[0]?.match(/\bload\(\)/gu)).toHaveLength(1);
  });

  it('does not transfer a guard to a different receiver or property path', () => {
    const contents = emitConsumer(
      `export function compare(first: Readonly<Request>, second: Readonly<Request>): boolean {
         return first.body !== undefined && second.body !== null && first.alternate !== null;
       }`,
    );

    expect(presenceTests(contents)).toEqual([
      'flight::row_get<flight::RowKey<"body">>(first) => presence_operand.has_value()',
      'flight::row_get<flight::RowKey<"body">>(second) => !presence_operand.has_value() || presence_operand.value().has_value()',
      'flight::row_get<flight::RowKey<"alternate">>(first) => !presence_operand.has_value() || presence_operand.value().has_value()',
    ]);
  });

  it('drops the earlier property proof when an assignment can replace the value', () => {
    const contents = emitConsumer(
      `export function replace(request: Request, replacement: Body | undefined): boolean {
         if (request.body === undefined) return false;
         request.body = replacement;
         return request.body !== null;
       }`,
    );

    expect(presenceTests(contents)).toEqual([
      'request->body => !presence_operand.has_value()',
      'request->body => !presence_operand.has_value() || presence_operand.value().has_value()',
    ]);
  });

  it('preserves undefined while a preceding strict null test narrows only null', () => {
    const contents = emitConsumer(
      `type LocalBody = string | number[] | null;
       interface LocalRequest { body?: LocalBody }
       export function present(request: Readonly<LocalRequest>): boolean {
         return request.body !== null && request.body !== undefined;
       }`,
    );

    expect(presenceTests(contents)).toEqual([
      `${requestBody} => !presence_operand.has_value() || presence_operand.value().has_value()`,
      `${requestBody} => presence_operand.has_value()`,
    ]);
  });

  it('keeps an optional-chain access on the optional-chain lane', () => {
    const contents = emitConsumer(
      `export function chained(envelope: Readonly<Envelope>): boolean {
         return envelope.request?.body !== null;
       }`,
    );

    expect(contents).toContain('optional_chain');
    expect(presenceTests(contents)).toEqual([]);
  });
});
