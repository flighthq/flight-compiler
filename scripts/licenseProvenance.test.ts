import { describe, expect, it } from 'vitest';

import { collectLicenseSignals } from './licenseProvenance.js';

const ownAttribution = 'Joshua Granick';

function rules(contents: string): string[] {
  return collectLicenseSignals(contents, ownAttribution).map((signal) => signal.rule);
}

describe('collectLicenseSignals', () => {
  it('reports a foreign copyright notice', () => {
    expect(rules('// Copyright (c) 2019 Some Other Project')).toEqual(['foreign-copyright']);
    expect(rules('Copyright © 2020 Another Vendor')).toEqual(['foreign-copyright']);
    expect(rules('Copyright 2021 Someone Else')).toEqual(['foreign-copyright']);
  });

  it('accepts a copyright notice carrying this repository’s own attribution', () => {
    expect(collectLicenseSignals('Copyright (c) 2026 Joshua Granick and other contributors', ownAttribution)).toEqual(
      [],
    );
  });

  // Prose about copyright is contributor guidance, not licensed material. These are must-pass
  // negatives: the first version of this rule matched the bare word and flagged AGENTS.md twice.
  it('accepts prose that merely discusses copyright', () => {
    expect(rules('The root LICENSE.md is the operative license and copyright statement.')).toEqual([]);
    expect(rules('Preserve relevant copyright or provenance notices when adapting a script.')).toEqual([]);
    expect(rules('This has no copyrightable content.')).toEqual([]);
  });

  it('reports an embedded license body', () => {
    expect(rules('Permission is hereby granted, free of charge, to any person obtaining a copy')).toEqual([
      'license-body',
    ]);
    expect(rules('Redistribution and use in source and binary forms, with or without')).toEqual(['license-body']);
  });

  it('reports a license grant and an SPDX identifier', () => {
    expect(rules('// Licensed under the Apache License, Version 2.0')).toEqual(['license-grant']);
    expect(rules('// SPDX-License-Identifier: MIT')).toEqual(['spdx-identifier']);
  });

  it('reports a reservation of rights', () => {
    expect(rules('// All rights reserved.')).toEqual(['reserved-rights']);
  });

  it('reports the one-based line and a truncated detail', () => {
    const signals = collectLicenseSignals(['first', '// SPDX-License-Identifier: MIT'].join('\n'), ownAttribution);

    expect(signals).toEqual([{ detail: '// SPDX-License-Identifier: MIT', line: 2, rule: 'spdx-identifier' }]);
  });

  it('returns nothing for ordinary source', () => {
    expect(collectLicenseSignals('export function compileIrModules(): void {}\n', ownAttribution)).toEqual([]);
  });
});
