#pragma once

#include <cmath>
#include <concepts>

namespace flight {

template <typename Value>
struct SameValueZero {
  bool operator()(const Value& left, const Value& right) const noexcept(noexcept(left == right)) {
    if constexpr (std::floating_point<Value>) {
      return left == right || (std::isnan(left) && std::isnan(right));
    } else {
      return left == right;
    }
  }
};

template <typename Value>
bool same_value_zero(const Value& left, const Value& right)
    noexcept(noexcept(SameValueZero<Value>{}(left, right))) {
  return SameValueZero<Value>{}(left, right);
}

} // namespace flight
