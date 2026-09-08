#pragma once

#include <algorithm>
#include <cstddef>
#include <functional>
#include <initializer_list>
#include <iterator>
#include <memory>
#include <optional>
#include <tuple>
#include <utility>
#include <vector>

#include <flight/equality.hpp>

namespace flight {

template <typename Key, typename Value, typename Equal = SameValueZero<Key>>
class Map {
 public:
  using Entry = std::pair<Key, Value>;
  using size_type = typename std::vector<Entry>::size_type;

  Map() : entries_(std::make_shared<std::vector<Entry>>()) {}

  Map(std::initializer_list<Entry> entries) : Map() {
    for (const auto& [key, value] : entries) set(key, value);
  }

  template <typename Range>
    requires requires(const Range& range) {
      std::begin(range);
      std::end(range);
    }
  explicit Map(const Range& entries) : Map() {
    for (const auto& entry : entries) set(std::get<0>(entry), std::get<1>(entry));
  }

  [[nodiscard]] auto begin() const noexcept { return entries_->begin(); }
  [[nodiscard]] auto end() const noexcept { return entries_->end(); }

  void clear() noexcept { entries_->clear(); }

  [[nodiscard]] Map clone() const {
    Map result;
    *result.entries_ = *entries_;
    return result;
  }

  [[nodiscard]] bool empty() const noexcept { return entries_->empty(); }

  template <typename Function>
  void for_each(Function function) const {
    for (const auto& [key, value] : *entries_) std::invoke(function, value, key);
  }

  bool erase(const Key& key) {
    const auto entry = find(key);
    if (entry == entries_->end()) return false;
    entries_->erase(entry);
    return true;
  }

  [[nodiscard]] std::optional<Value> get(const Key& key) const {
    const auto entry = find(key);
    if (entry == entries_->end()) return std::nullopt;
    return entry->second;
  }

  [[nodiscard]] bool has(const Key& key) const { return find(key) != entries_->end(); }

  Map& set(Key key, Value value) {
    const auto entry = find(key);
    if (entry == entries_->end()) {
      entries_->emplace_back(std::move(key), std::move(value));
    } else {
      entry->second = std::move(value);
    }
    return *this;
  }

  [[nodiscard]] size_type size() const noexcept { return entries_->size(); }

 private:
  [[nodiscard]] auto find(const Key& key) {
    return std::find_if(entries_->begin(), entries_->end(), [&](const Entry& entry) {
      return equal_(entry.first, key);
    });
  }

  [[nodiscard]] auto find(const Key& key) const {
    return std::find_if(entries_->cbegin(), entries_->cend(), [&](const Entry& entry) {
      return equal_(entry.first, key);
    });
  }

  Equal equal_{};
  std::shared_ptr<std::vector<Entry>> entries_;
};

} // namespace flight
