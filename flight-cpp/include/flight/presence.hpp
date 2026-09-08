#pragma once

#include <compare>
#include <variant>

namespace flight {

struct Undefined {
  constexpr auto operator<=>(const Undefined&) const noexcept = default;
};

struct Null {
  constexpr auto operator<=>(const Null&) const noexcept = default;
};

inline constexpr Undefined undefined{};
inline constexpr Null null{};

template <typename Value>
using Presence = std::variant<Undefined, Null, Value>;

} // namespace flight
