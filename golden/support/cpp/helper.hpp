#pragma once
#include <string>

namespace flighthq_golden {

// The sibling module the import and facade fixtures name.
struct Shape {
  std::string kind;
};

struct Circle {
  std::string kind;
  double radius;
};

inline double helper(double value) { return value + 1.0; }

} // namespace flighthq_golden
