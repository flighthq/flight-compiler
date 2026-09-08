#pragma once

#include <algorithm>
#include <cstddef>
#include <initializer_list>
#include <memory>
#include <utility>
#include <vector>

#include <flight/equality.hpp>

namespace flight {

template <typename Value, typename Equal = SameValueZero<Value>>
class Set {
 public:
  using const_iterator = typename std::vector<Value>::const_iterator;
  using size_type = typename std::vector<Value>::size_type;

  Set() : values_(std::make_shared<std::vector<Value>>()) {}

  Set(std::initializer_list<Value> values) : Set() {
    for (const auto& value : values) add(value);
  }

  Set& add(Value value) {
    if (!has(value)) values_->push_back(std::move(value));
    return *this;
  }

  [[nodiscard]] const_iterator begin() const noexcept { return values_->begin(); }
  [[nodiscard]] const_iterator end() const noexcept { return values_->end(); }

  void clear() noexcept { values_->clear(); }

  [[nodiscard]] Set clone() const {
    Set result;
    *result.values_ = *values_;
    return result;
  }

  [[nodiscard]] bool empty() const noexcept { return values_->empty(); }

  bool erase(const Value& value) {
    const auto found = find(value);
    if (found == values_->end()) return false;
    values_->erase(found);
    return true;
  }

  [[nodiscard]] bool has(const Value& value) const { return find(value) != values_->end(); }
  [[nodiscard]] size_type size() const noexcept { return values_->size(); }

 private:
  [[nodiscard]] const_iterator find(const Value& value) const {
    return std::find_if(values_->cbegin(), values_->cend(), [&](const Value& candidate) {
      return equal_(candidate, value);
    });
  }

  Equal equal_{};
  std::shared_ptr<std::vector<Value>> values_;
};

} // namespace flight
