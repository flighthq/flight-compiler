#ifndef FLIGHT_CPP_C_RUNTIME_H
#define FLIGHT_CPP_C_RUNTIME_H

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32) && defined(FLIGHT_CPP_C_SHARED)
#if defined(FLIGHT_CPP_C_EXPORTS)
#define FLIGHT_CPP_C_API __declspec(dllexport)
#else
#define FLIGHT_CPP_C_API __declspec(dllimport)
#endif
#elif defined(__GNUC__) || defined(__clang__)
#define FLIGHT_CPP_C_API __attribute__((visibility("default")))
#else
#define FLIGHT_CPP_C_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct flight_cpp_error flight_cpp_error;
typedef struct flight_cpp_string flight_cpp_string;
typedef uint32_t flight_cpp_status;

enum {
  FLIGHT_CPP_STATUS_OK = 0,
  FLIGHT_CPP_STATUS_INVALID_ARGUMENT = 1,
  FLIGHT_CPP_STATUS_INVALID_UTF8 = 2,
  FLIGHT_CPP_STATUS_BUFFER_TOO_SMALL = 3,
  FLIGHT_CPP_STATUS_INTERNAL_ERROR = 4
};

FLIGHT_CPP_C_API uint32_t flight_cpp_abi_version(void);
FLIGHT_CPP_C_API const char* flight_cpp_version(void);

FLIGHT_CPP_C_API flight_cpp_status flight_cpp_error_create(
    const flight_cpp_string* message,
    flight_cpp_error** output);
FLIGHT_CPP_C_API flight_cpp_status flight_cpp_error_create_utf8(
    const char* bytes,
    size_t size,
    flight_cpp_error** output);
FLIGHT_CPP_C_API flight_cpp_status flight_cpp_error_message(
    const flight_cpp_error* value,
    flight_cpp_string** output);
FLIGHT_CPP_C_API flight_cpp_status flight_cpp_error_retain(flight_cpp_error* value);
FLIGHT_CPP_C_API void flight_cpp_error_release(flight_cpp_error* value);

FLIGHT_CPP_C_API flight_cpp_status flight_cpp_string_create_utf8(
    const char* bytes,
    size_t size,
    flight_cpp_string** output);
FLIGHT_CPP_C_API flight_cpp_status flight_cpp_string_retain(flight_cpp_string* value);
FLIGHT_CPP_C_API void flight_cpp_string_release(flight_cpp_string* value);
FLIGHT_CPP_C_API flight_cpp_status flight_cpp_string_utf8_size(
    const flight_cpp_string* value,
    size_t* size);
FLIGHT_CPP_C_API flight_cpp_status flight_cpp_string_copy_utf8(
    const flight_cpp_string* value,
    char* output,
    size_t capacity,
    size_t* written);

#ifdef __cplusplus
}
#endif

#endif
