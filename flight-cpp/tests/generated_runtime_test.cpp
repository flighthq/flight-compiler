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

  check(flighthq_cpp_conformance::increment(flight::Task<double>::ready(4.0)).get() == 5.0,
        "generated coroutine resumes through the task executor");
  return failures == 0 ? 0 : 1;
}
