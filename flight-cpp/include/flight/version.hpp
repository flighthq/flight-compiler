#pragma once

#include <cstdint>
#include <string_view>

#define FLIGHT_CPP_VERSION_MAJOR 0
#define FLIGHT_CPP_VERSION_MINOR 1
#define FLIGHT_CPP_VERSION_PATCH 0
#define FLIGHT_CPP_ABI_VERSION 1

namespace flight {

inline constexpr std::uint32_t version_major = FLIGHT_CPP_VERSION_MAJOR;
inline constexpr std::uint32_t version_minor = FLIGHT_CPP_VERSION_MINOR;
inline constexpr std::uint32_t version_patch = FLIGHT_CPP_VERSION_PATCH;
inline constexpr std::uint32_t abi_version = FLIGHT_CPP_ABI_VERSION;
inline constexpr std::string_view version = "0.1.0";

} // namespace flight
