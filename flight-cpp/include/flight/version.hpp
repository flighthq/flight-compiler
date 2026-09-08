#pragma once

#include <cstdint>
#include <string_view>

namespace flight {

inline constexpr std::uint32_t version_major = 0;
inline constexpr std::uint32_t version_minor = 1;
inline constexpr std::uint32_t version_patch = 0;
inline constexpr std::string_view version = "0.1.0";

} // namespace flight
