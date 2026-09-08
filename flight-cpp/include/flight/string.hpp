#pragma once

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <concepts>
#include <compare>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <type_traits>
#include <utility>

#include <flight/array.hpp>

namespace flight {

class UnicodeService {
 public:
  UnicodeService() = default;
  UnicodeService(const UnicodeService&) = delete;
  UnicodeService& operator=(const UnicodeService&) = delete;
  virtual ~UnicodeService() = default;

  [[nodiscard]] virtual std::u16string lower(std::u16string_view value) const = 0;
  [[nodiscard]] virtual std::u16string upper(std::u16string_view value) const = 0;
};

class UnicodeServiceUnavailable final : public std::runtime_error {
 public:
  UnicodeServiceUnavailable()
      : std::runtime_error("non-ASCII case conversion requires a flight::UnicodeService") {}
};

namespace detail {

inline thread_local std::shared_ptr<const UnicodeService> active_unicode_service;

} // namespace detail

class UnicodeServiceScope {
 public:
  explicit UnicodeServiceScope(std::shared_ptr<const UnicodeService> service)
      : previous_(std::move(detail::active_unicode_service)) {
    if (!service) throw std::invalid_argument("flight::UnicodeServiceScope requires a service");
    detail::active_unicode_service = std::move(service);
  }

  UnicodeServiceScope(const UnicodeServiceScope&) = delete;
  UnicodeServiceScope& operator=(const UnicodeServiceScope&) = delete;

  ~UnicodeServiceScope() { detail::active_unicode_service = std::move(previous_); }

 private:
  std::shared_ptr<const UnicodeService> previous_;
};

class String {
 public:
  using const_iterator = std::u16string::const_iterator;
  using size_type = std::u16string::size_type;

  String() = default;
  String(const char* utf8) : String(std::string_view(utf8)) {}
  String(const char16_t* value) : value_(value) {}
  String(std::string utf8) : value_(decode_utf8(utf8)) {}
  String(std::string_view utf8) : value_(decode_utf8(utf8)) {}
  String(std::u16string value) : value_(std::move(value)) {}
  String(std::u16string_view value) : value_(value) {}

  [[nodiscard]] static String from_utf8(std::string_view value) { return String(value); }

  [[nodiscard]] static String from_number(double value) {
    if (std::isnan(value)) return String("NaN");
    if (std::isinf(value)) return String(value < 0 ? "-Infinity" : "Infinity");
    if (value == 0.0) return String("0");

    std::array<char, 64> buffer{};
    const auto conversion = std::to_chars(buffer.data(), buffer.data() + buffer.size(), value);
    if (conversion.ec != std::errc{}) throw std::runtime_error("flight::String number conversion failed");
    return String::from_utf8(format_number(std::string(buffer.data(), conversion.ptr)));
  }

  template <typename... Codes>
    requires(std::is_arithmetic_v<Codes> && ...)
  [[nodiscard]] static String from_char_code(Codes... codes) {
    std::u16string result;
    result.reserve(sizeof...(Codes));
    (result.push_back(to_uint16(static_cast<double>(codes))), ...);
    return String(std::move(result));
  }

  [[nodiscard]] std::optional<char16_t> at(std::ptrdiff_t index) const noexcept {
    const auto normalized = normalize_element_index(index);
    return normalized ? std::optional<char16_t>(value_[*normalized]) : std::nullopt;
  }

  [[nodiscard]] const_iterator begin() const noexcept { return value_.begin(); }
  [[nodiscard]] const_iterator end() const noexcept { return value_.end(); }
  [[nodiscard]] bool empty() const noexcept { return value_.empty(); }

  [[nodiscard]] String char_at(std::ptrdiff_t index) const {
    if (index < 0 || static_cast<size_type>(index) >= size()) return String();
    return String(std::u16string(1, value_[static_cast<size_type>(index)]));
  }

  [[nodiscard]] double char_code_at(std::ptrdiff_t index) const noexcept {
    if (index < 0 || static_cast<size_type>(index) >= size()) {
      return std::numeric_limits<double>::quiet_NaN();
    }
    return static_cast<double>(value_[static_cast<size_type>(index)]);
  }

  template <typename... Values>
    requires(std::same_as<std::remove_cvref_t<Values>, String> && ...)
  [[nodiscard]] String concat(const Values&... values) const {
    auto result = value_;
    (result.append(values.value_), ...);
    return String(std::move(result));
  }

  [[nodiscard]] bool ends_with(const String& suffix) const noexcept {
    return value_.ends_with(suffix.value_);
  }

  [[nodiscard]] bool includes(const String& searched) const noexcept {
    return value_.find(searched.value_) != std::u16string::npos;
  }

  [[nodiscard]] std::ptrdiff_t index_of(const String& searched, std::ptrdiff_t from = 0) const noexcept {
    const auto start = from <= 0 ? size_type{0} : std::min(static_cast<size_type>(from), size());
    const auto found = value_.find(searched.value_, start);
    return found == std::u16string::npos ? -1 : static_cast<std::ptrdiff_t>(found);
  }

  [[nodiscard]] static String join(const Array<String>& values, const String& separator) {
    std::u16string result;
    bool first = true;
    for (const auto& value : values) {
      if (!first) result.append(separator.value_);
      result.append(value.value_);
      first = false;
    }
    return String(std::move(result));
  }

  [[nodiscard]] size_type length() const noexcept { return value_.size(); }

  [[nodiscard]] std::ptrdiff_t last_index_of(const String& searched) const noexcept {
    const auto found = value_.rfind(searched.value_);
    return found == std::u16string::npos ? -1 : static_cast<std::ptrdiff_t>(found);
  }

  [[nodiscard]] const std::u16string& native() const noexcept { return value_; }

  [[nodiscard]] String pad_start(std::ptrdiff_t target_length, const String& fill = String(" ")) const {
    if (target_length <= 0 || static_cast<size_type>(target_length) <= size() || fill.empty()) return *this;
    const auto required = static_cast<size_type>(target_length) - size();
    std::u16string padding;
    padding.reserve(required);
    while (padding.size() < required) {
      const auto remaining = required - padding.size();
      padding.append(fill.value_, 0, std::min(remaining, fill.size()));
    }
    padding.append(value_);
    return String(std::move(padding));
  }

  [[nodiscard]] String repeat(std::ptrdiff_t count) const {
    if (count < 0) throw std::range_error("flight::String repeat count must be nonnegative");
    std::u16string result;
    const auto repetitions = static_cast<size_type>(count);
    if (!value_.empty() && repetitions > result.max_size() / value_.size()) {
      throw std::length_error("flight::String repeat result is too large");
    }
    result.reserve(value_.size() * repetitions);
    for (size_type index = 0; index < repetitions; ++index) result.append(value_);
    return String(std::move(result));
  }

  [[nodiscard]] String replace(const String& searched, const String& replacement) const {
    auto result = value_;
    const auto found = result.find(searched.value_);
    if (found != std::u16string::npos) result.replace(found, searched.length(), replacement.value_);
    return String(std::move(result));
  }

  [[nodiscard]] String slice(
      std::ptrdiff_t begin_index,
      std::ptrdiff_t end_index = std::numeric_limits<std::ptrdiff_t>::max()) const {
    const auto first = normalize_boundary(begin_index);
    const auto last = normalize_boundary(end_index);
    return last <= first ? String() : String(value_.substr(first, last - first));
  }

  [[nodiscard]] Array<String> split(
      const String& separator,
      size_type limit = std::numeric_limits<size_type>::max()) const {
    Array<String> result;
    if (limit == 0) return result;
    if (separator.empty()) {
      for (const auto unit : value_) {
        if (result.size() == limit) break;
        result.push(String(std::u16string(1, unit)));
      }
      return result;
    }

    size_type position = 0;
    while (result.size() < limit) {
      const auto found = value_.find(separator.value_, position);
      if (found == std::u16string::npos) {
        result.push(String(value_.substr(position)));
        break;
      }
      result.push(String(value_.substr(position, found - position)));
      position = found + separator.length();
    }
    return result;
  }

  [[nodiscard]] bool starts_with(const String& prefix) const noexcept {
    return value_.starts_with(prefix.value_);
  }

  [[nodiscard]] String substring(
      std::ptrdiff_t begin_index,
      std::ptrdiff_t end_index = std::numeric_limits<std::ptrdiff_t>::max()) const {
    auto first = normalize_substring_boundary(begin_index);
    auto last = normalize_substring_boundary(end_index);
    if (first > last) std::swap(first, last);
    return String(value_.substr(first, last - first));
  }

  [[nodiscard]] String to_lower() const {
    return convert_case(false);
  }

  [[nodiscard]] std::string to_utf8() const {
    std::string result;
    result.reserve(value_.size());
    for (size_type index = 0; index < value_.size(); ++index) {
      std::uint32_t code_point = value_[index];
      if (code_point >= 0xD800 && code_point <= 0xDBFF) {
        if (index + 1 < value_.size()) {
          const auto low = static_cast<std::uint32_t>(value_[index + 1]);
          if (low >= 0xDC00 && low <= 0xDFFF) {
            code_point = 0x10000 + ((code_point - 0xD800) << 10) + (low - 0xDC00);
            ++index;
          } else {
            code_point = 0xFFFD;
          }
        } else {
          code_point = 0xFFFD;
        }
      } else if (code_point >= 0xDC00 && code_point <= 0xDFFF) {
        code_point = 0xFFFD;
      }
      append_utf8(result, code_point);
    }
    return result;
  }

  [[nodiscard]] String to_upper() const {
    return convert_case(true);
  }

  [[nodiscard]] String trim() const {
    size_type first = 0;
    while (first < value_.size() && is_whitespace(value_[first])) ++first;
    size_type last = value_.size();
    while (last > first && is_whitespace(value_[last - 1])) --last;
    return String(value_.substr(first, last - first));
  }

  [[nodiscard]] friend bool operator==(const String&, const String&) noexcept = default;
  [[nodiscard]] friend auto operator<=>(const String&, const String&) noexcept = default;

  String& operator+=(const String& other) {
    value_.append(other.value_);
    return *this;
  }

  [[nodiscard]] friend String operator+(const String& left, const String& right) {
    auto value = left.value_;
    value.append(right.value_);
    return String(std::move(value));
  }

 private:
  [[nodiscard]] static std::string expand_decimal_exponent(std::string value, int exponent) {
    const bool negative = value.starts_with('-');
    if (negative) value.erase(0, 1);
    const auto point = value.find('.');
    const auto fractional = point == std::string::npos ? 0 : value.size() - point - 1;
    if (point != std::string::npos) value.erase(point, 1);
    const auto decimal = static_cast<std::ptrdiff_t>(value.size() - fractional) + exponent;
    std::string result = negative ? "-" : "";
    if (decimal <= 0) {
      result += "0.";
      result.append(static_cast<std::size_t>(-decimal), '0');
      result += value;
    } else if (static_cast<std::size_t>(decimal) >= value.size()) {
      result += value;
      result.append(static_cast<std::size_t>(decimal) - value.size(), '0');
    } else {
      result += value.substr(0, static_cast<std::size_t>(decimal));
      result += '.';
      result += value.substr(static_cast<std::size_t>(decimal));
    }
    return result;
  }

  [[nodiscard]] static std::string format_number(std::string value) {
    const auto marker = value.find_first_of("eE");
    if (marker == std::string::npos) return value;
    const auto mantissa = value.substr(0, marker);
    int exponent = 0;
    auto exponent_begin = value.data() + marker + 1;
    const auto exponent_end = value.data() + value.size();
    const bool positive = exponent_begin != exponent_end && *exponent_begin == '+';
    if (positive) ++exponent_begin;
    const auto parsed = std::from_chars(exponent_begin, exponent_end, exponent);
    if (parsed.ec != std::errc{} || parsed.ptr != exponent_end) {
      throw std::runtime_error("flight::String exponent conversion failed");
    }
    if (exponent >= -6 && exponent < 21) return expand_decimal_exponent(mantissa, exponent);
    return mantissa + "e" + (exponent >= 0 ? "+" : "") + std::to_string(exponent);
  }

  [[nodiscard]] static std::u16string decode_utf8(std::string_view utf8) {
    std::u16string result;
    for (size_type index = 0; index < utf8.size();) {
      const auto first = static_cast<std::uint8_t>(utf8[index]);
      std::uint32_t code_point = 0;
      size_type continuation_count = 0;
      if (first <= 0x7F) {
        code_point = first;
      } else if (first >= 0xC2 && first <= 0xDF) {
        code_point = first & 0x1F;
        continuation_count = 1;
      } else if (first >= 0xE0 && first <= 0xEF) {
        code_point = first & 0x0F;
        continuation_count = 2;
      } else if (first >= 0xF0 && first <= 0xF4) {
        code_point = first & 0x07;
        continuation_count = 3;
      } else {
        throw std::invalid_argument("invalid UTF-8 leading byte");
      }
      if (index + continuation_count >= utf8.size()) {
        throw std::invalid_argument("truncated UTF-8 sequence");
      }
      for (size_type offset = 1; offset <= continuation_count; ++offset) {
        const auto continuation = static_cast<std::uint8_t>(utf8[index + offset]);
        if ((continuation & 0xC0) != 0x80) throw std::invalid_argument("invalid UTF-8 continuation byte");
        code_point = (code_point << 6) | (continuation & 0x3F);
      }
      if ((continuation_count == 1 && code_point < 0x80) ||
          (continuation_count == 2 && code_point < 0x800) ||
          (continuation_count == 3 && code_point < 0x10000) || code_point > 0x10FFFF ||
          (code_point >= 0xD800 && code_point <= 0xDFFF)) {
        throw std::invalid_argument("non-scalar or overlong UTF-8 sequence");
      }
      if (code_point <= 0xFFFF) {
        result.push_back(static_cast<char16_t>(code_point));
      } else {
        code_point -= 0x10000;
        result.push_back(static_cast<char16_t>(0xD800 + (code_point >> 10)));
        result.push_back(static_cast<char16_t>(0xDC00 + (code_point & 0x3FF)));
      }
      index += continuation_count + 1;
    }
    return result;
  }

  static void append_utf8(std::string& output, std::uint32_t code_point) {
    if (code_point <= 0x7F) {
      output.push_back(static_cast<char>(code_point));
    } else if (code_point <= 0x7FF) {
      output.push_back(static_cast<char>(0xC0 | (code_point >> 6)));
      output.push_back(static_cast<char>(0x80 | (code_point & 0x3F)));
    } else if (code_point <= 0xFFFF) {
      output.push_back(static_cast<char>(0xE0 | (code_point >> 12)));
      output.push_back(static_cast<char>(0x80 | ((code_point >> 6) & 0x3F)));
      output.push_back(static_cast<char>(0x80 | (code_point & 0x3F)));
    } else {
      output.push_back(static_cast<char>(0xF0 | (code_point >> 18)));
      output.push_back(static_cast<char>(0x80 | ((code_point >> 12) & 0x3F)));
      output.push_back(static_cast<char>(0x80 | ((code_point >> 6) & 0x3F)));
      output.push_back(static_cast<char>(0x80 | (code_point & 0x3F)));
    }
  }

  [[nodiscard]] String convert_case(bool upper) const {
    const auto non_ascii = std::find_if(value_.begin(), value_.end(), [](char16_t unit) { return unit > 0x7F; });
    if (non_ascii != value_.end()) {
      if (!detail::active_unicode_service) throw UnicodeServiceUnavailable();
      return String(upper ? detail::active_unicode_service->upper(value_)
                          : detail::active_unicode_service->lower(value_));
    }

    auto result = value_;
    for (auto& unit : result) {
      if (upper && unit >= u'a' && unit <= u'z') unit = static_cast<char16_t>(unit - (u'a' - u'A'));
      if (!upper && unit >= u'A' && unit <= u'Z') unit = static_cast<char16_t>(unit + (u'a' - u'A'));
    }
    return String(std::move(result));
  }

  [[nodiscard]] static bool is_whitespace(char16_t unit) noexcept {
    return (unit >= 0x0009 && unit <= 0x000D) || unit == 0x0020 || unit == 0x00A0 ||
           unit == 0x1680 || (unit >= 0x2000 && unit <= 0x200A) || unit == 0x2028 ||
           unit == 0x2029 || unit == 0x202F || unit == 0x205F || unit == 0x3000 ||
           unit == 0xFEFF;
  }

  [[nodiscard]] size_type normalize_substring_boundary(std::ptrdiff_t index) const noexcept {
    if (index <= 0) return 0;
    return std::min(static_cast<size_type>(index), size());
  }

  [[nodiscard]] static char16_t to_uint16(double value) noexcept {
    if (!std::isfinite(value) || value == 0.0) return 0;
    auto reduced = std::fmod(std::trunc(value), 65536.0);
    if (reduced < 0.0) reduced += 65536.0;
    return static_cast<char16_t>(reduced);
  }

  [[nodiscard]] size_type normalize_boundary(std::ptrdiff_t index) const noexcept {
    if (index < 0) {
      const auto magnitude = static_cast<size_type>(-(index + 1)) + 1;
      return magnitude >= size() ? 0 : size() - magnitude;
    }
    return std::min(static_cast<size_type>(index), size());
  }

  [[nodiscard]] std::optional<size_type> normalize_element_index(std::ptrdiff_t index) const noexcept {
    const auto boundary = normalize_boundary(index);
    if ((index >= 0 && boundary >= size()) || (index < 0 && static_cast<size_type>(-(index + 1)) >= size())) {
      return std::nullopt;
    }
    return boundary;
  }

  [[nodiscard]] size_type size() const noexcept { return value_.size(); }

  std::u16string value_;
};

} // namespace flight

namespace flight {

[[nodiscard]] inline String to_string(const String& value) { return value; }

[[nodiscard]] inline String to_string(bool value) { return String(value ? "true" : "false"); }

template <typename Value>
  requires std::is_arithmetic_v<Value> && (!std::same_as<std::remove_cv_t<Value>, bool>)
[[nodiscard]] inline String to_string(Value value) {
  return String::from_number(static_cast<double>(value));
}

} // namespace flight
