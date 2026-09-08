#include "generated/semantic_runtime.hpp"

#include <iostream>

namespace {

int failures = 0;

void check(bool condition, const char* message) {
  if (condition) return;
  std::cerr << "FAIL: " << message << '\n';
  ++failures;
}

} // namespace

int main() {
  check(flighthq_cpp_conformance::summarize(flight::Array<double>{2.0, 3.0}) == flight::String("2|4"),
        "generated array callbacks and UTF-16 join execute through flight-cpp");

  flight::Map<flight::String, double> labels;
  flight::Set<flight::String> seen;
  check(flighthq_cpp_conformance::update(labels, seen) == 1.0 && labels.get("size") == 1.0 && seen.has("size"),
        "generated map and set operations preserve shared identity");

  flight::Uint8Array bytes{0, 0};
  check(flighthq_cpp_conformance::overwrite(bytes, flight::Array<double>{7.0, 8.0}) == 7.0 && bytes[1] == 8,
        "generated typed-array set writes through shared storage");

  auto first_counter = flighthq_cpp_conformance::create_counter(0.0);
  auto second_counter = flighthq_cpp_conformance::create_counter(10.0);
  check(first_counter() == 1.0 && first_counter() == 2.0 && second_counter() == 11.0 && second_counter() == 12.0,
        "generated escaping closures retain independent shared mutable state");

  check(flighthq_cpp_conformance::observe_after_creation() == 7.0,
        "generated closures observe outer mutation after creation");

  check(flighthq_cpp_conformance::select_first_key(flighthq_cpp_conformance::ForInValues{1.0}) ==
            flight::String("value"),
        "generated function-scoped for-in key retains string type evidence");

  check(flighthq_cpp_conformance::increment(flight::Task<double>::ready(4.0)).get() == 5.0,
        "generated coroutine resumes through the task executor");
  return failures == 0 ? 0 : 1;
}
