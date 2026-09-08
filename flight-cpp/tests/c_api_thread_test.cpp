#include <flight/c/runtime.h>

#include <array>
#include <atomic>
#include <cstddef>
#include <thread>
#include <vector>

int main() {
  constexpr char text[] = "ready";
  constexpr std::size_t thread_count = 8;
  flight_cpp_string* shared_string = nullptr;
  flight_cpp_error* shared_error = nullptr;
  if (flight_cpp_string_create_utf8(text, sizeof(text) - 1, &shared_string) != FLIGHT_CPP_STATUS_OK)
    return 1;
  if (flight_cpp_error_create(shared_string, &shared_error) != FLIGHT_CPP_STATUS_OK) return 2;

  std::atomic_bool failed{false};
  std::vector<std::thread> threads;
  threads.reserve(thread_count);
  for (std::size_t index = 0; index < thread_count; ++index) {
    if (flight_cpp_string_retain(shared_string) != FLIGHT_CPP_STATUS_OK ||
        flight_cpp_error_retain(shared_error) != FLIGHT_CPP_STATUS_OK)
      return 3;
    threads.emplace_back([&failed, shared_error, shared_string] {
      size_t size = 0;
      if (flight_cpp_string_utf8_size(shared_string, &size) != FLIGHT_CPP_STATUS_OK ||
          size != sizeof(text) - 1) {
        failed.store(true, std::memory_order_relaxed);
      }
      flight_cpp_string* message = nullptr;
      if (flight_cpp_error_message(shared_error, &message) != FLIGHT_CPP_STATUS_OK) {
        failed.store(true, std::memory_order_relaxed);
      } else {
        std::array<char, sizeof(text) - 1> output{};
        size_t written = 0;
        if (flight_cpp_string_copy_utf8(message, output.data(), output.size(), &written) !=
                FLIGHT_CPP_STATUS_OK ||
            written != output.size()) {
          failed.store(true, std::memory_order_relaxed);
        }
        flight_cpp_string_release(message);
      }
      flight_cpp_error_release(shared_error);
      flight_cpp_string_release(shared_string);
    });
  }
  for (auto& thread : threads) thread.join();
  flight_cpp_error_release(shared_error);
  flight_cpp_string_release(shared_string);
  return failed.load(std::memory_order_relaxed) ? 4 : 0;
}
