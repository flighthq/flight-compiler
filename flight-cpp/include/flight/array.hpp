#pragma once

#include <algorithm>
#include <cmath>
#include <concepts>
#include <cstddef>
#include <functional>
#include <initializer_list>
#include <iterator>
#include <limits>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

#include <flight/equality.hpp>

namespace flight {

class String;

namespace detail {

template <typename Function, typename Element>
decltype(auto) invoke_array_callback(Function& function, Element&& element, std::size_t index) {
  if constexpr (std::invocable<Function&, Element, double>) {
    return std::invoke(function, std::forward<Element>(element), static_cast<double>(index));
  } else {
    return std::invoke(function, std::forward<Element>(element));
  }
}

} // namespace detail

template <typename Value>
class Array {
 public:
  using const_iterator = typename std::vector<Value>::const_iterator;
  using const_reference = typename std::vector<Value>::const_reference;
  using iterator = typename std::vector<Value>::iterator;
  using reference = typename std::vector<Value>::reference;
  using size_type = typename std::vector<Value>::size_type;
  using value_type = Value;

  Array() : values_(std::make_shared<std::vector<Value>>()) {}

  explicit Array(size_type length)
      : values_(std::make_shared<std::vector<Value>>(length)) {}

  Array(std::initializer_list<Value> values)
      : values_(std::make_shared<std::vector<Value>>(values)) {}

  template <std::input_iterator Iterator>
  Array(Iterator first, Iterator last)
      : values_(std::make_shared<std::vector<Value>>(first, last)) {}

  [[nodiscard]] const_reference operator[](size_type index) const noexcept { return (*values_)[index]; }
  [[nodiscard]] reference operator[](size_type index) noexcept { return (*values_)[index]; }

  [[nodiscard]] std::optional<Value> at(size_type index) const {
    if (index >= size()) return std::nullopt;
    return (*values_)[index];
  }

  [[nodiscard]] std::optional<Value> at(size_type index) {
    if (index >= size()) return std::nullopt;
    return (*values_)[index];
  }

  [[nodiscard]] reference element(double index) { return (*values_)[required_index(index)]; }
  [[nodiscard]] const_reference element(double index) const { return (*values_)[required_index(index)]; }

  [[nodiscard]] std::optional<Value> get(double index) const {
    const auto normalized = property_index(index);
    return normalized ? std::optional<Value>((*values_)[*normalized]) : std::nullopt;
  }

  [[nodiscard]] const_iterator begin() const noexcept { return values_->begin(); }
  [[nodiscard]] iterator begin() noexcept { return values_->begin(); }
  [[nodiscard]] const_iterator cbegin() const noexcept { return values_->cbegin(); }
  [[nodiscard]] const_iterator cend() const noexcept { return values_->cend(); }

  void clear() noexcept { values_->clear(); }

  [[nodiscard]] Array clone() const { return Array(values_->begin(), values_->end()); }

  template <typename... Arrays>
    requires(std::same_as<std::remove_cvref_t<Arrays>, Array> && ...)
  [[nodiscard]] Array concat(const Arrays&... others) const {
    Array result = clone();
    (result.values_->insert(result.values_->end(), others.begin(), others.end()), ...);
    return result;
  }

  [[nodiscard]] const_iterator end() const noexcept { return values_->end(); }
  [[nodiscard]] iterator end() noexcept { return values_->end(); }
  [[nodiscard]] bool empty() const noexcept { return values_->empty(); }

  template <typename Predicate>
  [[nodiscard]] bool every(Predicate predicate) const {
    for (size_type index = 0; index < size(); ++index) {
      if (!detail::invoke_array_callback(predicate, (*values_)[index], index)) return false;
    }
    return true;
  }

  Array& fill(Value value, std::ptrdiff_t begin_index = 0,
              std::ptrdiff_t end_index = std::numeric_limits<std::ptrdiff_t>::max()) {
    const auto first = normalize_boundary(begin_index);
    const auto last = normalize_boundary(end_index);
    if (last > first) {
      std::fill(values_->begin() + static_cast<std::ptrdiff_t>(first),
                values_->begin() + static_cast<std::ptrdiff_t>(last), value);
    }
    return *this;
  }

  template <typename Predicate>
  [[nodiscard]] Array filter(Predicate&& predicate) const {
    Array result;
    for (size_type index = 0; index < size(); ++index) {
      const auto& value = (*values_)[index];
      if (detail::invoke_array_callback(predicate, value, index)) result.values_->push_back(value);
    }
    return result;
  }

  template <typename Predicate>
  [[nodiscard]] std::optional<Value> find(Predicate predicate) const {
    for (size_type index = 0; index < size(); ++index) {
      const auto& value = (*values_)[index];
      if (detail::invoke_array_callback(predicate, value, index)) return value;
    }
    return std::nullopt;
  }

  template <typename Predicate>
  [[nodiscard]] std::ptrdiff_t find_index(Predicate predicate) const {
    for (size_type index = 0; index < size(); ++index) {
      if (detail::invoke_array_callback(predicate, (*values_)[index], index)) {
        return static_cast<std::ptrdiff_t>(index);
      }
    }
    return -1;
  }

  template <typename Function>
  void for_each(Function function) const {
    for (size_type index = 0; index < size(); ++index) {
      detail::invoke_array_callback(function, (*values_)[index], index);
    }
  }

  [[nodiscard]] bool includes(const Value& searched) const {
    return std::ranges::any_of(*values_, [&](const Value& value) {
      return same_value_zero(value, searched);
    });
  }

  [[nodiscard]] std::ptrdiff_t index_of(const Value& searched) const {
    const auto found = std::ranges::find_if(*values_, [&](const Value& value) {
      return same_value_zero(value, searched);
    });
    return found == values_->end() ? -1 : std::distance(values_->begin(), found);
  }

  template <typename StringValue = String>
  [[nodiscard]] StringValue join(const StringValue& separator = StringValue(",")) const {
    StringValue result;
    for (size_type index = 0; index < size(); ++index) {
      if (index > 0) result = result + separator;
      result = result + stringify<StringValue>((*values_)[index]);
    }
    return result;
  }

  [[nodiscard]] std::ptrdiff_t last_index_of(const Value& searched) const {
    for (size_type index = size(); index > 0; --index) {
      if (same_value_zero((*values_)[index - 1], searched)) {
        return static_cast<std::ptrdiff_t>(index - 1);
      }
    }
    return -1;
  }

  template <typename Transform>
  [[nodiscard]] auto map(Transform&& transform) const
      -> Array<std::remove_cvref_t<decltype(detail::invoke_array_callback(
          transform, std::declval<const Value&>(), std::declval<size_type>()))>> {
    using Result = std::remove_cvref_t<decltype(detail::invoke_array_callback(
        transform, std::declval<const Value&>(), std::declval<size_type>()))>;
    Array<Result> result;
    for (size_type index = 0; index < size(); ++index) {
      result.push(detail::invoke_array_callback(transform, (*values_)[index], index));
    }
    return result;
  }

  [[nodiscard]] std::optional<Value> pop() {
    if (empty()) return std::nullopt;
    Value value = std::move(values_->back());
    values_->pop_back();
    return value;
  }

  size_type push(Value value) {
    values_->push_back(std::move(value));
    return size();
  }

  template <typename... Items>
    requires(std::constructible_from<Value, Items&&> && ...)
  size_type push(Items&&... items) requires(sizeof...(Items) != 1) {
    (values_->emplace_back(std::forward<Items>(items)), ...);
    return size();
  }

  template <typename Accumulator, typename Fold>
  [[nodiscard]] Accumulator reduce(Fold fold, Accumulator accumulated) const {
    for (size_type index = 0; index < size(); ++index) {
      if constexpr (std::invocable<Fold&, Accumulator, const Value&, double>) {
        accumulated = std::invoke(fold, std::move(accumulated), (*values_)[index], static_cast<double>(index));
      } else {
        accumulated = std::invoke(fold, std::move(accumulated), (*values_)[index]);
      }
    }
    return accumulated;
  }

  Array& reverse() {
    std::ranges::reverse(*values_);
    return *this;
  }

  [[nodiscard]] std::optional<Value> shift() {
    if (empty()) return std::nullopt;
    Value value = std::move(values_->front());
    values_->erase(values_->begin());
    return value;
  }

  [[nodiscard]] Array slice(
      std::ptrdiff_t begin_index = 0,
      std::ptrdiff_t end_index = std::numeric_limits<std::ptrdiff_t>::max()) const {
    const auto first = normalize_boundary(begin_index);
    const auto last = normalize_boundary(end_index);
    if (last <= first) return Array();
    return Array(values_->begin() + static_cast<std::ptrdiff_t>(first),
                 values_->begin() + static_cast<std::ptrdiff_t>(last));
  }

  template <typename Predicate>
  [[nodiscard]] bool some(Predicate predicate) const {
    for (size_type index = 0; index < size(); ++index) {
      if (detail::invoke_array_callback(predicate, (*values_)[index], index)) return true;
    }
    return false;
  }

  Array& sort()
    requires std::totally_ordered<Value>
  {
    std::ranges::sort(*values_);
    return *this;
  }

  template <typename Compare>
  Array& sort(Compare compare) {
    std::ranges::sort(*values_, [&](const Value& left, const Value& right) {
      return std::invoke(compare, left, right) < 0;
    });
    return *this;
  }

  [[nodiscard]] Array splice(
      std::ptrdiff_t begin_index,
      std::ptrdiff_t count = std::numeric_limits<std::ptrdiff_t>::max()) {
    const auto first = normalize_boundary(begin_index);
    const auto available = size() - first;
    const auto removed_count = count <= 0
                                   ? size_type{0}
                                   : std::min(static_cast<size_type>(count), available);
    Array removed(values_->begin() + static_cast<std::ptrdiff_t>(first),
                  values_->begin() + static_cast<std::ptrdiff_t>(first + removed_count));
    values_->erase(values_->begin() + static_cast<std::ptrdiff_t>(first),
                   values_->begin() + static_cast<std::ptrdiff_t>(first + removed_count));
    return removed;
  }

  [[nodiscard]] size_type size() const noexcept { return values_->size(); }

  template <typename... Items>
    requires(std::constructible_from<Value, Items&&> && ...)
  size_type unshift(Items&&... items) {
    std::vector<Value> prefix;
    prefix.reserve(sizeof...(Items));
    (prefix.emplace_back(std::forward<Items>(items)), ...);
    values_->insert(values_->begin(), std::make_move_iterator(prefix.begin()),
                    std::make_move_iterator(prefix.end()));
    return size();
  }

 private:
  [[nodiscard]] std::optional<size_type> property_index(double index) const noexcept {
    if (!std::isfinite(index) || index < 0.0 || std::trunc(index) != index) return std::nullopt;
    if (index >= static_cast<double>(size())) return std::nullopt;
    return static_cast<size_type>(index);
  }

  [[nodiscard]] size_type required_index(double index) const {
    const auto normalized = property_index(index);
    if (!normalized) throw std::range_error("flight::Array index is outside the array");
    return *normalized;
  }

  [[nodiscard]] size_type normalize_boundary(std::ptrdiff_t index) const noexcept {
    if (index < 0) {
      const auto magnitude = static_cast<size_type>(-(index + 1)) + 1;
      return magnitude >= size() ? 0 : size() - magnitude;
    }
    return std::min(static_cast<size_type>(index), size());
  }

  template <typename StringValue>
  [[nodiscard]] static StringValue stringify(const Value& value) {
    if constexpr (std::constructible_from<StringValue, Value>) {
      return StringValue(value);
    } else if constexpr (std::same_as<Value, bool> && requires { StringValue::from_utf8(std::string_view{}); }) {
      return StringValue::from_utf8(value ? "true" : "false");
    } else if constexpr (std::is_arithmetic_v<Value> && requires { StringValue::from_number(double{}); }) {
      return StringValue::from_number(static_cast<double>(value));
    } else if constexpr (std::is_arithmetic_v<Value>) {
      std::ostringstream output;
      if constexpr (std::same_as<Value, bool>) output << std::boolalpha;
      output << value;
      return StringValue::from_utf8(output.str());
    } else {
      static_assert(std::constructible_from<StringValue, Value>,
                    "flight::Array::join requires a string-convertible element type");
    }
  }

  std::shared_ptr<std::vector<Value>> values_;
};

} // namespace flight

namespace flight {

template <typename Value>
[[nodiscard]] constexpr bool is_array(const Array<Value>&) noexcept {
  return true;
}

template <typename Value>
[[nodiscard]] constexpr bool is_array(const Value&) noexcept {
  return false;
}

} // namespace flight
