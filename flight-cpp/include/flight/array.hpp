#pragma once

#include <algorithm>
#include <cstddef>
#include <functional>
#include <initializer_list>
#include <iterator>
#include <memory>
#include <optional>
#include <type_traits>
#include <utility>
#include <vector>

#include <flight/equality.hpp>

namespace flight {

template <typename Value>
class Array {
 public:
  using const_iterator = typename std::vector<Value>::const_iterator;
  using iterator = typename std::vector<Value>::iterator;
  using size_type = typename std::vector<Value>::size_type;
  using value_type = Value;

  Array() : values_(std::make_shared<std::vector<Value>>()) {}

  Array(std::initializer_list<Value> values)
      : values_(std::make_shared<std::vector<Value>>(values)) {}

  template <std::input_iterator Iterator>
  Array(Iterator first, Iterator last)
      : values_(std::make_shared<std::vector<Value>>(first, last)) {}

  [[nodiscard]] const Value& operator[](size_type index) const noexcept { return (*values_)[index]; }
  [[nodiscard]] Value& operator[](size_type index) noexcept { return (*values_)[index]; }

  [[nodiscard]] std::optional<std::reference_wrapper<const Value>> at(size_type index) const noexcept {
    if (index >= size()) return std::nullopt;
    return std::cref((*values_)[index]);
  }

  [[nodiscard]] std::optional<std::reference_wrapper<Value>> at(size_type index) noexcept {
    if (index >= size()) return std::nullopt;
    return std::ref((*values_)[index]);
  }

  [[nodiscard]] const_iterator begin() const noexcept { return values_->begin(); }
  [[nodiscard]] iterator begin() noexcept { return values_->begin(); }
  [[nodiscard]] const_iterator cbegin() const noexcept { return values_->cbegin(); }
  [[nodiscard]] const_iterator cend() const noexcept { return values_->cend(); }

  void clear() noexcept { values_->clear(); }

  [[nodiscard]] Array clone() const { return Array(values_->begin(), values_->end()); }

  [[nodiscard]] Array concat(const Array& other) const {
    Array result = clone();
    result.values_->insert(result.values_->end(), other.begin(), other.end());
    return result;
  }

  [[nodiscard]] const_iterator end() const noexcept { return values_->end(); }
  [[nodiscard]] iterator end() noexcept { return values_->end(); }
  [[nodiscard]] bool empty() const noexcept { return values_->empty(); }

  template <typename Predicate>
  [[nodiscard]] Array filter(Predicate&& predicate) const {
    Array result;
    for (const auto& value : *values_) {
      if (std::invoke(predicate, value)) result.values_->push_back(value);
    }
    return result;
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

  template <typename Transform>
  [[nodiscard]] auto map(Transform&& transform) const
      -> Array<std::remove_cvref_t<std::invoke_result_t<Transform, const Value&>>> {
    using Result = std::remove_cvref_t<std::invoke_result_t<Transform, const Value&>>;
    Array<Result> result;
    for (const auto& value : *values_) result.push(std::invoke(transform, value));
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

  Array& reverse() {
    std::ranges::reverse(*values_);
    return *this;
  }

  [[nodiscard]] size_type size() const noexcept { return values_->size(); }

 private:
  std::shared_ptr<std::vector<Value>> values_;
};

} // namespace flight
