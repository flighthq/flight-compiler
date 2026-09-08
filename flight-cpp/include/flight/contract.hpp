#pragma once

#include <array>
#include <cstdint>
#include <string_view>

#include <flight/version.hpp>

namespace flight {

enum class RuntimeCapabilityStatus : std::uint8_t {
  initial,
  planned,
  unavailable,
};

struct RuntimeCapability {
  std::string_view name;
  RuntimeCapabilityStatus status;
};

struct RuntimeContract {
  std::string_view compiler_contract;
  std::uint32_t cpp_abi;
  std::string_view task_contract;
};

inline constexpr RuntimeContract runtime_contract{
    .compiler_contract = "flight-runtime-contract/2",
    .cpp_abi = abi_version,
    .task_contract = "flight-runtime-task-capability-abi/1",
};

inline constexpr std::array runtime_capabilities{
    RuntimeCapability{"array", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"date", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"executor", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"error", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"float32-array", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"float64-array", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"int8-array", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"int16-array", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"int32-array", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"map", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"set", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"string", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"task-coroutine", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"typed-array", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"uint8-array", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"uint8-clamped-array", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"uint16-array", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"uint32-array", RuntimeCapabilityStatus::initial},
    RuntimeCapability{"unicode-case-service", RuntimeCapabilityStatus::planned},
    RuntimeCapability{"task-promise-operations", RuntimeCapabilityStatus::initial},
};

constexpr RuntimeCapabilityStatus runtime_capability_status(std::string_view name) noexcept {
  for (const auto& capability : runtime_capabilities) {
    if (capability.name == name) return capability.status;
  }
  return RuntimeCapabilityStatus::unavailable;
}

} // namespace flight
