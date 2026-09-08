#include <flight/runtime.hpp>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <limits>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

namespace {

int failures = 0;

void check(bool condition, const char* message) {
  if (condition) return;
  std::cerr << "FAIL: " << message << '\n';
  ++failures;
}

class MarkerUnicodeService final : public flight::UnicodeService {
 public:
  explicit MarkerUnicodeService(std::u16string marker) : marker_(std::move(marker)) {}

  [[nodiscard]] std::u16string lower(std::u16string_view value) const override {
    static_cast<void>(value);
    return marker_;
  }

  [[nodiscard]] std::u16string upper(std::u16string_view value) const override {
    static_cast<void>(value);
    return marker_;
  }

 private:
  std::u16string marker_;
};

[[nodiscard]] std::size_t normalize_slice_boundary(std::ptrdiff_t index, std::size_t length) {
  if (index < 0) {
    const auto magnitude = static_cast<std::size_t>(-(index + 1)) + 1;
    return magnitude >= length ? 0 : length - magnitude;
  }
  return std::min(static_cast<std::size_t>(index), length);
}

[[nodiscard]] std::size_t normalize_substring_boundary(std::ptrdiff_t index,
                                                       std::size_t length) {
  if (index <= 0) return 0;
  return std::min(static_cast<std::size_t>(index), length);
}

void test_collection_mutation() {
  const auto first_nan = std::numeric_limits<double>::quiet_NaN();
  const auto second_nan = std::nan("42");
  flight::Map<double, int> numeric_map;
  numeric_map.set(first_nan, 1).set(second_nan, 2).set(-0.0, 3).set(0.0, 4);
  check(numeric_map.size() == 2 && numeric_map.get(first_nan) == std::optional<int>(2) &&
            numeric_map.get(-0.0) == std::optional<int>(4),
        "map maintains one SameValueZero entry for NaN and signed zero");
  auto numeric_key = numeric_map.begin();
  ++numeric_key;
  check(!std::signbit(numeric_key->first), "map canonicalizes an inserted negative-zero key");

  flight::Map<int, std::string> map{{1, "one"}, {2, "two"}, {3, "three"}};
  auto map_alias = map;
  std::vector<int> map_visits;
  std::vector<std::string> map_values;
  map.for_each([&](std::string value, int key) {
    map_visits.push_back(key);
    map_values.push_back(std::move(value));
    if (key == 1) {
      static_cast<void>(map_alias.erase(2));
      map_alias.set(4, "four");
    } else if (key == 3 && map_visits.size() == 2) {
      static_cast<void>(map_alias.erase(3));
      map_alias.set(3, "three-again");
    } else if (key == 4) {
      map_alias.set(4, "four-updated");
    }
  });
  check(map_visits == std::vector<int>({1, 3, 4, 3}) &&
            map_values == std::vector<std::string>({"one", "three", "four", "three-again"}),
        "map for_each skips deleted entries, visits appends, and revisits delete-reinsertions");

  flight::Map<int, int> cleared_map{{1, 1}};
  std::size_t cleared_map_visits = 0;
  cleared_map.for_each([&](int value, int key) {
    static_cast<void>(value);
    static_cast<void>(key);
    ++cleared_map_visits;
    if (cleared_map_visits == 1) {
      cleared_map.clear();
      cleared_map.set(1, 2);
    }
  });
  check(cleared_map_visits == 2 && cleared_map.get(1) == std::optional<int>(2),
        "map clear and same-key reinsertion creates a new visitable insertion");

  flight::Set<double> numeric_set{first_nan, second_nan, -0.0, 0.0};
  check(numeric_set.size() == 2 && numeric_set.has(second_nan),
        "set maintains one SameValueZero entry for NaN and signed zero");
  auto numeric_value = numeric_set.begin();
  ++numeric_value;
  check(!std::signbit(*numeric_value), "set canonicalizes an inserted negative-zero value");

  flight::Set<int> set{1, 2, 3};
  auto set_alias = set;
  std::vector<int> set_visits;
  set.for_each([&](int value) {
    set_visits.push_back(value);
    if (value == 1) {
      static_cast<void>(set_alias.erase(2));
      set_alias.add(4);
    } else if (value == 3 && set_visits.size() == 2) {
      static_cast<void>(set_alias.erase(3));
      set_alias.add(3);
    }
  });
  check(set_visits == std::vector<int>({1, 3, 4, 3}),
        "set for_each preserves insertion identities while callbacks mutate aliases");
}

void test_host_scope_isolation() {
  const auto original_executor = flight::current_executor();
  const auto outer_executor = std::make_shared<flight::QueueExecutor>();
  const auto inner_executor = std::make_shared<flight::QueueExecutor>();
  const auto outer_unicode = std::make_shared<MarkerUnicodeService>(u"outer");
  const auto inner_unicode = std::make_shared<MarkerUnicodeService>(u"inner");

  {
    const flight::HostScope outer({.executor = outer_executor, .unicode = outer_unicode});
    check(flight::current_executor() == outer_executor &&
              flight::String(u"\u00C4").to_lower() == flight::String(u"outer"),
          "outer host scope installs both services");
    {
      const flight::HostScope inner({.executor = inner_executor, .unicode = inner_unicode});
      check(flight::current_executor() == inner_executor &&
                flight::String(u"\u00C4").to_lower() == flight::String(u"inner"),
            "nested host scope overrides both services");
    }
    check(flight::current_executor() == outer_executor &&
              flight::String(u"\u00C4").to_lower() == flight::String(u"outer"),
          "nested host scope restores both outer services");

    bool thread_used_default_executor = false;
    bool thread_lacked_unicode = false;
    bool thread_scope_was_private = false;
    std::thread worker([&] {
      thread_used_default_executor = flight::current_executor() != outer_executor;
      try {
        static_cast<void>(flight::String(u"\u00C4").to_lower());
      } catch (const flight::UnicodeServiceUnavailable&) {
        thread_lacked_unicode = true;
      }

      const auto thread_executor = std::make_shared<flight::QueueExecutor>();
      const auto thread_unicode = std::make_shared<MarkerUnicodeService>(u"thread");
      const flight::HostScope thread_scope(
          {.executor = thread_executor, .unicode = thread_unicode});
      thread_scope_was_private =
          flight::current_executor() == thread_executor &&
          flight::String(u"\u00C4").to_lower() == flight::String(u"thread");
    });
    worker.join();
    check(thread_used_default_executor && thread_lacked_unicode && thread_scope_was_private,
          "host services are thread-local and can be scoped independently per thread");
    check(flight::current_executor() == outer_executor &&
              flight::String(u"\u00C4").to_lower() == flight::String(u"outer"),
          "another thread cannot disturb the active host scope");
  }

  check(flight::current_executor() == original_executor,
        "outer host scope restores the original executor");
  bool unicode_restored = false;
  try {
    static_cast<void>(flight::String(u"\u00C4").to_lower());
  } catch (const flight::UnicodeServiceUnavailable&) {
    unicode_restored = true;
  }
  check(unicode_restored, "outer host scope restores the missing Unicode service");
}

void test_string_boundaries() {
  const std::vector<std::pair<std::string, std::u16string>> scalar_boundaries{
      {std::string("\x7F", 1), std::u16string(1, u'\x7F')},
      {std::string("\xC2\x80", 2), std::u16string(1, u'\x80')},
      {std::string("\xDF\xBF", 2), std::u16string(1, u'\x7FF')},
      {std::string("\xE0\xA0\x80", 3), std::u16string(1, u'\x800')},
      {std::string("\xED\x9F\xBF", 3), std::u16string(1, u'\xD7FF')},
      {std::string("\xEE\x80\x80", 3), std::u16string(1, u'\xE000')},
      {std::string("\xEF\xBF\xBF", 3), std::u16string(1, u'\xFFFF')},
      {std::string("\xF0\x90\x80\x80", 4), std::u16string(u"\U00010000")},
      {std::string("\xF4\x8F\xBF\xBF", 4), std::u16string(u"\U0010FFFF")},
  };
  for (const auto& [utf8, utf16] : scalar_boundaries) {
    const auto value = flight::String::from_utf8(utf8);
    check(value.native() == utf16 && value.to_utf8() == utf8,
          "UTF-8 scalar boundaries round-trip through exact UTF-16 code units");
  }

  const std::vector<std::string> invalid_utf8{
      std::string("\x80", 1),
      std::string("\xC0\x80", 2),
      std::string("\xE0\x80\x80", 3),
      std::string("\xED\xA0\x80", 3),
      std::string("\xF0\x80\x80\x80", 4),
      std::string("\xF4\x90\x80\x80", 4),
      std::string("\xE2\x82", 2),
      std::string("\xE2\x28\xA1", 3),
  };
  for (const auto& utf8 : invalid_utf8) {
    bool rejected = false;
    try {
      static_cast<void>(flight::String::from_utf8(utf8));
    } catch (const std::invalid_argument&) {
      rejected = true;
    }
    check(rejected, "invalid, overlong, truncated, and non-scalar UTF-8 is rejected");
  }

  const flight::String unpaired(
      std::u16string{static_cast<char16_t>(0xD800), u'A', static_cast<char16_t>(0xDC00)});
  check(unpaired.length() == 3 &&
            unpaired.to_utf8() == std::string("\xEF\xBF\xBD") + "A" + "\xEF\xBF\xBD",
        "unpaired surrogates stay addressable and encode as replacement characters");

  const flight::String value(u"A\U0001F600BC");
  const auto& native = value.native();
  const auto length = native.size();
  for (std::ptrdiff_t begin = -7; begin <= 7; ++begin) {
    for (std::ptrdiff_t end = -7; end <= 7; ++end) {
      const auto first = normalize_slice_boundary(begin, length);
      const auto last = normalize_slice_boundary(end, length);
      const auto expected_slice =
          last <= first ? std::u16string() : native.substr(first, last - first);
      check(value.slice(begin, end).native() == expected_slice,
            "string slice matches saturated UTF-16 boundary normalization");

      auto substring_first = normalize_substring_boundary(begin, length);
      auto substring_last = normalize_substring_boundary(end, length);
      if (substring_first > substring_last) std::swap(substring_first, substring_last);
      check(value.substring(begin, end).native() ==
                native.substr(substring_first, substring_last - substring_first),
            "string substring clamps and swaps UTF-16 boundaries");
    }
  }
  check(!value.at(-6).has_value() && value.at(-5) == std::optional<char16_t>(u'A') &&
            value.at(4) == std::optional<char16_t>(u'C') && !value.at(5).has_value(),
        "string at distinguishes exact negative and positive index boundaries");
}

void test_task_settlement() {
  const auto executor = std::make_shared<flight::QueueExecutor>();
  const auto direct = flight::Task<int>::create(
      [](auto resolve, auto reject) {
        resolve(7);
        reject(std::string("late"));
        resolve(9);
        throw std::runtime_error("later still");
      },
      executor);
  check(direct.get() == 7, "the first direct task settlement survives later calls and throws");

  std::optional<flight::Task<int>::Resolver> inner_resolve;
  const auto inner = flight::Task<int>::create(
      [&](auto resolve) { inner_resolve.emplace(resolve); }, executor);
  const auto adopted = flight::Task<int>::create(
      [&](auto resolve, auto reject) {
        resolve(inner);
        reject(std::string("must-not-win"));
        resolve(11);
      },
      executor);
  check(adopted.status() == flight::TaskStatus::pending,
        "resolving to a pending task retains a pending adopted settlement");
  (*inner_resolve)(13);
  check(adopted.get() == 13,
        "task adoption locks settlement before the adopted task completes");

  std::optional<flight::Task<void>::Resolver> void_inner_resolve;
  const auto void_inner = flight::Task<void>::create(
      [&](auto resolve) { void_inner_resolve.emplace(resolve); }, executor);
  const auto void_adopted = flight::Task<void>::create(
      [&](auto resolve, auto reject) {
        resolve(void_inner);
        reject(std::string("must-not-win"));
      },
      executor);
  (*void_inner_resolve)();
  void_adopted.get();
  check(void_adopted.status() == flight::TaskStatus::fulfilled,
        "void task adoption uses the same first-settlement lock");

  const auto source = flight::Task<int>::ready(20, executor);
  std::vector<int> continuation_order;
  std::optional<flight::Task<int>> tail;
  const auto first = source.then([&](int value) {
    continuation_order.push_back(1);
    tail.emplace(source.then([&](int nested) {
      continuation_order.push_back(3);
      return nested;
    }));
    return value + 1;
  });
  const auto second = source.then([&](int value) {
    continuation_order.push_back(2);
    return value + 2;
  });
  check(continuation_order.empty() && first.status() == flight::TaskStatus::pending &&
            second.status() == flight::TaskStatus::pending,
        "settled-task continuations remain queued and non-reentrant");
  static_cast<void>(executor->run_until_idle());
  check(continuation_order == std::vector<int>({1, 2, 3}) && first.get() == 21 &&
            second.get() == 22 && tail->get() == 20,
        "queued continuations retain registration order when one enqueues another");

  std::optional<flight::Task<void>::Resolver> cleanup_resolve;
  const auto cleanup = flight::Task<void>::create(
      [&](auto resolve) { cleanup_resolve.emplace(resolve); }, executor);
  const auto finalized = source.finally([cleanup] { return cleanup; });
  check(executor->run_one() && finalized.status() == flight::TaskStatus::pending,
        "finally waits after invoking pending asynchronous cleanup");
  (*cleanup_resolve)();
  check(finalized.status() == flight::TaskStatus::pending && executor->run_one() &&
            finalized.get() == 20,
        "finally preserves fulfillment only after cleanup settles");

  const auto original_rejection = flight::Task<int>::reject(std::string("original"), executor);
  const auto cleanup_rejection = original_rejection.finally(
      [executor] { return flight::Task<void>::reject(std::string("cleanup"), executor); });
  const auto settlement = cleanup_rejection.settle();
  check(settlement.status == flight::TaskStatus::rejected && settlement.rejection.has_value() &&
            settlement.rejection->is<std::string>() &&
            settlement.rejection->as<std::string>() == "cleanup",
        "a rejected asynchronous cleanup replaces the original rejection exactly");
}

void test_typed_array_views() {
  for (std::size_t length = 0; length <= 8; ++length) {
    flight::Int16Array values(length);
    for (std::size_t index = 0; index < length; ++index) {
      values[index] = static_cast<std::int16_t>(index + 10);
    }
    const auto signed_length = static_cast<std::ptrdiff_t>(length);
    for (std::ptrdiff_t index = -signed_length - 2; index <= signed_length + 2; ++index) {
      std::optional<std::int16_t> expected;
      if (index >= 0 && index < signed_length) {
        expected = static_cast<std::int16_t>(index + 10);
      } else if (index < 0 && -index <= signed_length) {
        expected = static_cast<std::int16_t>(signed_length + index + 10);
      }
      check(values.at(index) == expected,
            "typed-array at matches exact positive and negative index boundaries");
    }
  }

  flight::Int16Array values{1, 2, 3, 4, 5};
  auto alias = values;
  auto nested = alias.subarray(1, -1).subarray(1);
  nested[0] = 30;
  check(values[2] == 30 && nested.size() == 2,
        "nested typed-array views compose offsets and retain backing identity");

  values.set(values.subarray(0, 4), 1);
  check(values[0] == 1 && values[1] == 1 && values[2] == 2 && values[3] == 30 &&
            values[4] == 4,
        "overlapping typed-array set snapshots its source before writing");

  const auto before = values.slice(0);
  bool rejected = false;
  try {
    values.set(flight::Int16Array{8, 9}, 4);
  } catch (const std::range_error&) {
    rejected = true;
  }
  check(rejected && std::equal(values.begin(), values.end(), before.begin(), before.end()),
        "out-of-bounds typed-array set fails without partially modifying the view");

  check(!values.get(-1.0).has_value() && !values.get(1.5).has_value() &&
            !values.get(std::numeric_limits<double>::infinity()).has_value() &&
            !values.get(std::numeric_limits<double>::quiet_NaN()).has_value(),
        "typed-array property access rejects non-canonical numeric indices");
}

} // namespace

int main() {
  test_collection_mutation();
  test_host_scope_isolation();
  test_string_boundaries();
  test_task_settlement();
  test_typed_array_views();
  return failures == 0 ? 0 : 1;
}
