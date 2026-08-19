// Detects licensed material that has entered the tree as text.
//
// AGENTS.md states that the root LICENSE.md is the operative license and that third-party source,
// fixtures, corpora, specifications, and definition files are not copied here. That rule has no
// enforcement, and its failure mode is quiet: a pasted header or license body creates an attribution
// obligation nobody recorded, and it reads as ordinary boilerplate to every later reader.
//
// The signals are deliberately narrow — a license body, an SPDX identifier, a foreign copyright
// line, a reservation of rights. Each is a phrase that means something legally rather than a keyword
// that might appear in prose, so a hit is worth reading rather than worth suppressing.
//
// This cannot see a line-by-line translation of a reference implementation carrying no notice. That
// remains a review question, stated here so the gate's silence is not read as its absence.

export interface LicenseSignal {
  readonly detail: string;
  readonly line: number;
  readonly rule: string;
}

interface LicenseRule {
  readonly name: string;
  readonly pattern: RegExp;
}

const rules: readonly LicenseRule[] = [
  { name: 'license-body', pattern: /Permission is hereby granted, free of charge/iu },
  { name: 'license-body', pattern: /Redistribution and use in source and binary forms/iu },
  { name: 'license-grant', pattern: /Licensed under the (?:Apache|MIT|BSD|GNU|Mozilla)/iu },
  { name: 'reserved-rights', pattern: /All rights reserved/iu },
  { name: 'spdx-identifier', pattern: /SPDX-License-Identifier/u },
];

// A notice, not the word. Prose *about* copyright — "preserve relevant copyright notices" — is
// ordinary contributor guidance and must not be a finding, so the pattern requires the shape a real
// notice takes: a `(c)`, a `©`, or a year immediately after the word.
const copyrightPattern = /copyright\s*(?:\(c\)|©|(?:19|20)\d{2})/iu;

export function collectLicenseSignals(contents: string, ownAttribution: string): LicenseSignal[] {
  const signals: LicenseSignal[] = [];
  contents.split('\n').forEach((text, index) => {
    for (const rule of rules) {
      if (rule.pattern.test(text))
        signals.push({ detail: text.trim().slice(0, 120), line: index + 1, rule: rule.name });
    }
    // A copyright line naming this repository's own attribution is the expected case; one naming
    // anyone else is the finding.
    if (copyrightPattern.test(text) && !text.includes(ownAttribution)) {
      signals.push({ detail: text.trim().slice(0, 120), line: index + 1, rule: 'foreign-copyright' });
    }
  });
  return signals;
}
