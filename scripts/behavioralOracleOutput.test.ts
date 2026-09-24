import { describe, expect, it } from 'vitest';

import { splitBehavioralOracleOutput } from './behavioralOracleOutput.js';

describe('splitBehavioralOracleOutput', () => {
  it('normalizes CRLF record separators without trimming answer contents', () => {
    const lineFeedOutput = 'same\ntrailing space \nlone\rcarriage return\n';
    const windowsOutput = 'same\r\ntrailing space \r\nlone\rcarriage return\r\n';

    expect(splitBehavioralOracleOutput(windowsOutput)).toEqual(splitBehavioralOracleOutput(lineFeedOutput));
    expect(splitBehavioralOracleOutput(windowsOutput)).toEqual(['same', 'trailing space ', 'lone\rcarriage return']);
  });
});
