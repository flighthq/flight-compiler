#pragma once

#include <cmath>

namespace flight {

inline double sign(double value) noexcept {
  if (value == 0.0 || std::isnan(value)) return value;
  return value < 0.0 ? -1.0 : 1.0;
}

} // namespace flight
