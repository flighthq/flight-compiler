#include <flight/c/runtime.h>

#include <flight/error.hpp>
#include <flight/string.hpp>
#include <flight/version.hpp>

#include <atomic>
#include <cstring>
#include <limits>
#include <new>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

struct flight_cpp_string {
  std::atomic_size_t references{1};
  flight::String value;

  explicit flight_cpp_string(flight::String source) : value(std::move(source)) {}
};

struct flight_cpp_error {
  std::atomic_size_t references{1};
  flight::Error value;

  explicit flight_cpp_error(flight::String message) : value(std::move(message)) {}
};

namespace {

template <typename Handle>
flight_cpp_status retain_handle(Handle* value) {
  if (!value) return FLIGHT_CPP_STATUS_INVALID_ARGUMENT;
  auto references = value->references.load(std::memory_order_relaxed);
  do {
    if (references == std::numeric_limits<std::size_t>::max()) return FLIGHT_CPP_STATUS_INTERNAL_ERROR;
  } while (!value->references.compare_exchange_weak(
      references, references + 1, std::memory_order_relaxed, std::memory_order_relaxed));
  return FLIGHT_CPP_STATUS_OK;
}

template <typename Handle>
void release_handle(Handle* value) {
  if (!value) return;
  if (value->references.fetch_sub(1, std::memory_order_acq_rel) == 1) delete value;
}

} // namespace

extern "C" {

uint32_t flight_cpp_abi_version(void) { return FLIGHT_CPP_ABI_VERSION; }

const char* flight_cpp_version(void) { return flight::version.data(); }

flight_cpp_status flight_cpp_error_create(
    const flight_cpp_string* message,
    flight_cpp_error** output) {
  if (!output) return FLIGHT_CPP_STATUS_INVALID_ARGUMENT;
  *output = nullptr;
  if (!message) return FLIGHT_CPP_STATUS_INVALID_ARGUMENT;
  try {
    *output = new flight_cpp_error(message->value);
    return FLIGHT_CPP_STATUS_OK;
  } catch (...) {
    return FLIGHT_CPP_STATUS_INTERNAL_ERROR;
  }
}

flight_cpp_status flight_cpp_error_create_utf8(
    const char* bytes,
    size_t size,
    flight_cpp_error** output) {
  if (!output) return FLIGHT_CPP_STATUS_INVALID_ARGUMENT;
  *output = nullptr;
  if (!bytes && size != 0) return FLIGHT_CPP_STATUS_INVALID_ARGUMENT;
  try {
    const std::string_view source = size == 0 ? std::string_view{} : std::string_view(bytes, size);
    *output = new flight_cpp_error(flight::String::from_utf8(source));
    return FLIGHT_CPP_STATUS_OK;
  } catch (const std::invalid_argument&) {
    return FLIGHT_CPP_STATUS_INVALID_UTF8;
  } catch (...) {
    return FLIGHT_CPP_STATUS_INTERNAL_ERROR;
  }
}

flight_cpp_status flight_cpp_error_message(
    const flight_cpp_error* value,
    flight_cpp_string** output) {
  if (!output) return FLIGHT_CPP_STATUS_INVALID_ARGUMENT;
  *output = nullptr;
  if (!value) return FLIGHT_CPP_STATUS_INVALID_ARGUMENT;
  try {
    *output = new flight_cpp_string(value->value.message());
    return FLIGHT_CPP_STATUS_OK;
  } catch (...) {
    return FLIGHT_CPP_STATUS_INTERNAL_ERROR;
  }
}

flight_cpp_status flight_cpp_error_retain(flight_cpp_error* value) { return retain_handle(value); }

void flight_cpp_error_release(flight_cpp_error* value) { release_handle(value); }

flight_cpp_status flight_cpp_string_create_utf8(
    const char* bytes,
    size_t size,
    flight_cpp_string** output) {
  if (!output) return FLIGHT_CPP_STATUS_INVALID_ARGUMENT;
  *output = nullptr;
  if (!bytes && size != 0) return FLIGHT_CPP_STATUS_INVALID_ARGUMENT;
  try {
    const std::string_view source = size == 0 ? std::string_view{} : std::string_view(bytes, size);
    *output = new flight_cpp_string(flight::String::from_utf8(source));
    return FLIGHT_CPP_STATUS_OK;
  } catch (const std::invalid_argument&) {
    return FLIGHT_CPP_STATUS_INVALID_UTF8;
  } catch (...) {
    return FLIGHT_CPP_STATUS_INTERNAL_ERROR;
  }
}

flight_cpp_status flight_cpp_string_retain(flight_cpp_string* value) { return retain_handle(value); }

void flight_cpp_string_release(flight_cpp_string* value) { release_handle(value); }

flight_cpp_status flight_cpp_string_utf8_size(const flight_cpp_string* value, size_t* size) {
  if (!value || !size) return FLIGHT_CPP_STATUS_INVALID_ARGUMENT;
  try {
    *size = value->value.to_utf8().size();
    return FLIGHT_CPP_STATUS_OK;
  } catch (...) {
    return FLIGHT_CPP_STATUS_INTERNAL_ERROR;
  }
}

flight_cpp_status flight_cpp_string_copy_utf8(
    const flight_cpp_string* value,
    char* output,
    size_t capacity,
    size_t* written) {
  if (!value || !written || (!output && capacity != 0)) return FLIGHT_CPP_STATUS_INVALID_ARGUMENT;
  try {
    const std::string encoded = value->value.to_utf8();
    *written = encoded.size();
    if (capacity < encoded.size()) return FLIGHT_CPP_STATUS_BUFFER_TOO_SMALL;
    if (!encoded.empty()) std::memcpy(output, encoded.data(), encoded.size());
    return FLIGHT_CPP_STATUS_OK;
  } catch (...) {
    return FLIGHT_CPP_STATUS_INTERNAL_ERROR;
  }
}

} // extern "C"
