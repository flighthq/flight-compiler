#pragma once

#include <algorithm>
#include <cmath>
#include <compare>
#include <concepts>
#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <iterator>
#include <limits>
#include <memory>
#include <optional>
#include <span>
#include <stdexcept>
#include <type_traits>
#include <utility>
#include <vector>

namespace flight {

class Uint8Clamped {
 public:
  constexpr Uint8Clamped() noexcept = default;

  template <typename Number>
    requires std::is_arithmetic_v<Number>
  Uint8Clamped(Number value) noexcept : value_(clamp(static_cast<double>(value))) {}

  [[nodiscard]] constexpr operator std::uint8_t() const noexcept { return value_; }
  [[nodiscard]] constexpr auto operator<=>(const Uint8Clamped&) const noexcept = default;

 private:
  [[nodiscard]] static std::uint8_t clamp(double value) noexcept {
    if (std::isnan(value) || value <= 0.0) return 0;
    if (value >= 255.0) return 255;
    const auto lower = std::floor(value);
    const auto fraction = value - lower;
    if (fraction > 0.5 || (fraction == 0.5 && std::fmod(lower, 2.0) != 0.0)) {
      return static_cast<std::uint8_t>(lower + 1.0);
    }
    return static_cast<std::uint8_t>(lower);
  }

  std::uint8_t value_ = 0;
};

template <typename Value>
  requires(std::is_arithmetic_v<Value> || std::same_as<Value, Uint8Clamped>)
class TypedArray {
 public:
  using const_iterator = typename std::vector<Value>::const_iterator;
  using iterator = typename std::vector<Value>::iterator;
  using size_type = typename std::vector<Value>::size_type;
  using value_type = Value;

  TypedArray() : storage_(std::make_shared<std::vector<Value>>()) {}

  explicit TypedArray(size_type length)
      : length_(length), storage_(std::make_shared<std::vector<Value>>(length)) {}

  TypedArray(std::initializer_list<Value> values)
      : length_(values.size()), storage_(std::make_shared<std::vector<Value>>(values)) {}

  template <typename Range>
    requires requires(const Range& range) {
      std::begin(range);
      std::end(range);
    }
  explicit TypedArray(const Range& values)
      : TypedArray(std::begin(values), std::end(values)) {}

  [[nodiscard]] const Value& operator[](size_type index) const noexcept { return (*storage_)[offset_ + index]; }
  [[nodiscard]] Value& operator[](size_type index) noexcept { return (*storage_)[offset_ + index]; }

  [[nodiscard]] std::optional<Value> at(std::ptrdiff_t index) const {
    const auto normalized = normalize_element_index(index);
    if (!normalized) return std::nullopt;
    return (*this)[*normalized];
  }

  [[nodiscard]] Value& element(double index) { return (*this)[required_index(index)]; }
  [[nodiscard]] const Value& element(double index) const { return (*this)[required_index(index)]; }

  [[nodiscard]] std::optional<Value> get(double index) const {
    const auto normalized = property_index(index);
    return normalized ? std::optional<Value>((*this)[*normalized]) : std::nullopt;
  }

  [[nodiscard]] const_iterator begin() const noexcept {
    return storage_->cbegin() + static_cast<std::ptrdiff_t>(offset_);
  }

  [[nodiscard]] iterator begin() noexcept {
    return storage_->begin() + static_cast<std::ptrdiff_t>(offset_);
  }

  [[nodiscard]] const_iterator end() const noexcept {
    return begin() + static_cast<std::ptrdiff_t>(length_);
  }

  [[nodiscard]] iterator end() noexcept { return begin() + static_cast<std::ptrdiff_t>(length_); }
  [[nodiscard]] bool empty() const noexcept { return length_ == 0; }

  TypedArray& fill(Value value) {
    std::fill(begin(), end(), std::move(value));
    return *this;
  }

  [[nodiscard]] size_type size() const noexcept { return length_; }

  template <typename Range>
    requires requires(const Range& range) {
      std::begin(range);
      std::end(range);
    }
  void set(const Range& source, std::ptrdiff_t offset = 0) {
    if (offset < 0 || static_cast<size_type>(offset) > length_) {
      throw std::range_error("flight::TypedArray set offset is outside the view");
    }
    std::vector<Value> snapshot;
    for (const auto& value : source) snapshot.emplace_back(value);
    const auto target = static_cast<size_type>(offset);
    if (snapshot.size() > length_ - target) {
      throw std::range_error("flight::TypedArray source does not fit the view");
    }
    std::move(snapshot.begin(), snapshot.end(), begin() + static_cast<std::ptrdiff_t>(target));
  }

  [[nodiscard]] std::span<const Value> span() const noexcept {
    const auto* data = storage_->data();
    return std::span<const Value>(length_ == 0 ? data : data + offset_, length_);
  }

  [[nodiscard]] std::span<Value> span() noexcept {
    auto* data = storage_->data();
    return std::span<Value>(length_ == 0 ? data : data + offset_, length_);
  }

  [[nodiscard]] TypedArray slice(std::ptrdiff_t begin_index,
                                 std::ptrdiff_t end_index = std::numeric_limits<std::ptrdiff_t>::max()) const {
    const auto first = normalize_boundary(begin_index);
    const auto last = normalize_boundary(end_index);
    if (last <= first) return TypedArray();
    return TypedArray(begin() + static_cast<std::ptrdiff_t>(first),
                      begin() + static_cast<std::ptrdiff_t>(last));
  }

  [[nodiscard]] TypedArray subarray(
      std::ptrdiff_t begin_index,
      std::ptrdiff_t end_index = std::numeric_limits<std::ptrdiff_t>::max()) const noexcept {
    const auto first = normalize_boundary(begin_index);
    const auto last = normalize_boundary(end_index);
    return TypedArray(storage_, offset_ + first, last <= first ? 0 : last - first);
  }

 private:
  [[nodiscard]] std::optional<size_type> property_index(double index) const noexcept {
    if (!std::isfinite(index) || index < 0.0 || std::trunc(index) != index) return std::nullopt;
    if (index >= static_cast<double>(length_)) return std::nullopt;
    return static_cast<size_type>(index);
  }

  [[nodiscard]] size_type required_index(double index) const {
    const auto normalized = property_index(index);
    if (!normalized) throw std::range_error("flight::TypedArray index is outside the view");
    return *normalized;
  }

  template <typename Iterator>
  TypedArray(Iterator first, Iterator last)
      : length_(static_cast<size_type>(std::distance(first, last))),
        storage_(std::make_shared<std::vector<Value>>(first, last)) {}

  TypedArray(std::shared_ptr<std::vector<Value>> storage, size_type offset, size_type length) noexcept
      : length_(length), offset_(offset), storage_(std::move(storage)) {}

  [[nodiscard]] size_type normalize_boundary(std::ptrdiff_t index) const noexcept {
    if (index < 0) {
      const auto magnitude = static_cast<size_type>(-(index + 1)) + 1;
      return magnitude >= length_ ? 0 : length_ - magnitude;
    }
    const auto positive = static_cast<size_type>(index);
    return std::min(positive, length_);
  }

  [[nodiscard]] std::optional<size_type> normalize_element_index(std::ptrdiff_t index) const noexcept {
    if (index < 0) {
      const auto boundary = normalize_boundary(index);
      if (boundary >= length_) return std::nullopt;
      return boundary;
    }
    const auto positive = static_cast<size_type>(index);
    return positive < length_ ? std::optional<size_type>(positive) : std::nullopt;
  }

  size_type length_ = 0;
  size_type offset_ = 0;
  std::shared_ptr<std::vector<Value>> storage_;
};

using Float32Array = TypedArray<float>;
using Float64Array = TypedArray<double>;
using Int8Array = TypedArray<std::int8_t>;
using Int16Array = TypedArray<std::int16_t>;
using Int32Array = TypedArray<std::int32_t>;
using Uint8Array = TypedArray<std::uint8_t>;
using Uint8ClampedArray = TypedArray<Uint8Clamped>;
using Uint16Array = TypedArray<std::uint16_t>;
using Uint32Array = TypedArray<std::uint32_t>;

} // namespace flight
