import { describe, expect, it } from 'vitest';

import { inferCppValueType, renderCppValue, toCppName } from './behavioralOracleCpp.js';

describe('C++ behavioral-oracle values', () => {
  it('constructs referenced records recursively and infers arrays of references', () => {
    const rect = {
      $type: 'Rect',
      origin: { $type: 'Point', x: 1, y: 2 },
      size: { $type: 'Point', x: 3, y: 4 },
    };

    expect(inferCppValueType([rect])).toBe('flight::Array<flight::Ref<flighthq_golden::Rect>>');
    expect(renderCppValue(rect)).toBe(
      'flight::make_ref<flighthq_golden::Rect>(flighthq_golden::Rect{.origin = flight::make_ref<flighthq_golden::Point>(flighthq_golden::Point{.x = 1.0, .y = 2.0}), .size = flight::make_ref<flighthq_golden::Point>(flighthq_golden::Point{.x = 3.0, .y = 4.0})})',
    );
  });

  it('renders explicit arrays, optional references, and tuples by their ABI hints', () => {
    const point = { x: 3, y: 4 };

    expect(renderCppValue([point], 'flight::Array<flight::Ref<flighthq_golden::Point>>')).toBe(
      'flight::Array<flight::Ref<flighthq_golden::Point>>{flight::make_ref<flighthq_golden::Point>(flighthq_golden::Point{.x = 3.0, .y = 4.0})}',
    );
    expect(renderCppValue(point, 'std::optional<flight::Ref<flighthq_golden::Point>>')).toBe(
      'std::optional<flight::Ref<flighthq_golden::Point>>{flight::make_ref<flighthq_golden::Point>(flighthq_golden::Point{.x = 3.0, .y = 4.0})}',
    );
    expect(renderCppValue(null, 'std::optional<flight::Ref<flighthq_golden::Point>>')).toBe('std::nullopt');
    expect(renderCppValue([10, 'hello'], 'std::tuple<double, flight::String>')).toBe(
      'std::make_tuple(10.0, flight::String("hello"))',
    );
  });

  it('rejects malformed structural hints and preserves keyword-safe names', () => {
    expect(() => renderCppValue([1], 'std::tuple<double, flight::String>')).toThrow('does not match');
    expect(() => renderCppValue({}, 'flight::Array<double>')).toThrow('needs an array value');
    expect(toCppName('and')).toBe('and_');
    expect(toCppName('camelCase')).toBe('camel_case');
  });
});
