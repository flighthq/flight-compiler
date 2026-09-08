#pragma once

#include <cmath>

namespace flight {

inline constexpr double e = 2.718281828459045235360287471352662498;
inline constexpr double pi = 3.141592653589793238462643383279502884;

inline double round(double value) noexcept {
  if (!std::isfinite(value) || value == 0.0) return value;
  if (value < 0.0 && value >= -0.5) return -0.0;

  const double lower = std::floor(value);
  return value - lower < 0.5 ? lower : lower + 1.0;
}

inline double sign(double value) noexcept {
  if (value == 0.0 || std::isnan(value)) return value;
  return value < 0.0 ? -1.0 : 1.0;
}

} // namespace flight
