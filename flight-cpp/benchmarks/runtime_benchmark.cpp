#include <flight/runtime.hpp>

#include <chrono>
#include <cstddef>
#include <iostream>
#include <string_view>

namespace {

using Clock = std::chrono::steady_clock;

double observed = 0.0;

template <typename Operation>
double operations_per_second(std::size_t operations, Operation&& operation) {
  const auto start = Clock::now();
  operation();
  const auto elapsed = std::chrono::duration<double>(Clock::now() - start).count();
  return static_cast<double>(operations) / elapsed;
}

bool report(std::string_view name, double rate, double minimum) {
  std::cout << "{\"benchmark\":\"" << name << "\",\"operationsPerSecond\":" << rate
            << ",\"minimum\":" << minimum << "}\n";
  return rate >= minimum;
}

} // namespace

int main() {
  constexpr std::size_t collection_iterations = 200'000;
  const auto collection_rate = operations_per_second(collection_iterations * 3, [] {
    flight::Array<double> values;
    for (std::size_t index = 0; index < collection_iterations; ++index) {
      values.push(static_cast<double>(index));
    }
    const auto mapped = values.map([](double value) { return value + 1.0; });
    observed = mapped.reduce([](double total, double value) { return total + value; }, 0.0);
  });

  constexpr std::size_t map_iterations = 50'000;
  const auto map_rate = operations_per_second(map_iterations * 2, [] {
    flight::Map<double, double> values;
    for (std::size_t index = 0; index < map_iterations; ++index) {
      const auto key = static_cast<double>(index % 128);
      values.set(key, static_cast<double>(index));
      observed += values.get(key).value_or(0.0);
    }
  });

  constexpr std::size_t task_iterations = 10'000;
  const auto task_rate = operations_per_second(task_iterations, [] {
    auto task = flight::Task<double>::ready(0.0);
    for (std::size_t index = 0; index < task_iterations; ++index) {
      task = task.then([](double value) { return value + 1.0; });
    }
    observed += task.get();
  });

  const bool collection_passed = report("array-map-reduce", collection_rate, 50'000.0);
  const bool map_passed = report("ordered-map-update-read", map_rate, 10'000.0);
  const bool task_passed = report("settled-task-chain", task_rate, 2'000.0);
  if (observed == 0.0) return 2;
  return collection_passed && map_passed && task_passed ? 0 : 1;
}
