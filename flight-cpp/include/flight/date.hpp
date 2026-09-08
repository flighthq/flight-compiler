#pragma once

#include <chrono>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>

namespace flight {

class Date {
 public:
  Date() noexcept : milliseconds_(now().milliseconds_) {}
  explicit Date(double milliseconds) noexcept : milliseconds_(time_clip(milliseconds)) {}

  [[nodiscard]] static Date now() noexcept {
    const auto elapsed = std::chrono::system_clock::now().time_since_epoch();
    return Date(std::chrono::duration<double, std::milli>(elapsed).count());
  }

  [[nodiscard]] double get_full_year() const noexcept {
    if (!calendar_supported()) return std::numeric_limits<double>::quiet_NaN();
    const auto date = std::chrono::year_month_day(std::chrono::floor<std::chrono::days>(time_point()));
    return static_cast<double>(static_cast<int>(date.year()));
  }

  [[nodiscard]] double get_time() const noexcept { return milliseconds_; }

  [[nodiscard]] std::string to_isostring() const {
    if (!calendar_supported()) throw std::range_error("flight::Date is outside the supported calendar range");

    const auto point = time_point();
    const auto day = std::chrono::floor<std::chrono::days>(point);
    const auto date = std::chrono::year_month_day(day);
    const auto time = std::chrono::hh_mm_ss(point - day);

    std::ostringstream output;
    const auto year = static_cast<int>(date.year());
    output << std::setfill('0');
    if (year >= 0 && year <= 9999) {
      output << std::setw(4) << year;
    } else {
      output << (year < 0 ? '-' : '+') << std::setw(6) << std::abs(year);
    }
    output << '-' << std::setw(2) << static_cast<unsigned>(date.month()) << '-' << std::setw(2)
           << static_cast<unsigned>(date.day()) << 'T' << std::setw(2) << time.hours().count() << ':'
           << std::setw(2) << time.minutes().count() << ':' << std::setw(2) << time.seconds().count()
           << '.' << std::setw(3) << time.subseconds().count() << 'Z';
    return output.str();
  }

  [[nodiscard]] bool valid() const noexcept { return std::isfinite(milliseconds_); }

 private:
  using Milliseconds = std::chrono::milliseconds;
  using TimePoint = std::chrono::sys_time<Milliseconds>;

  [[nodiscard]] bool calendar_supported() const noexcept {
    if (!valid()) return false;
    const auto day = std::chrono::floor<std::chrono::days>(time_point());
    const auto first = std::chrono::sys_days(std::chrono::year::min() / std::chrono::January / 1);
    const auto last = std::chrono::sys_days(std::chrono::year::max() / std::chrono::December / 31);
    return day >= first && day <= last;
  }

  [[nodiscard]] static double time_clip(double milliseconds) noexcept {
    constexpr double limit = 8.64e15;
    if (!std::isfinite(milliseconds) || std::abs(milliseconds) > limit) {
      return std::numeric_limits<double>::quiet_NaN();
    }
    return std::trunc(milliseconds);
  }

  [[nodiscard]] TimePoint time_point() const noexcept {
    return TimePoint(Milliseconds(static_cast<std::int64_t>(std::floor(milliseconds_))));
  }

  double milliseconds_;
};

} // namespace flight
