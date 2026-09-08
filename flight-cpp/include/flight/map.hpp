#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <initializer_list>
#include <iterator>
#include <limits>
#include <memory>
#include <optional>
#include <stdexcept>
#include <tuple>
#include <utility>
#include <vector>

#include <flight/equality.hpp>

namespace flight {

template <typename Key, typename Value, typename Equal = SameValueZero<Key>>
class Map {
 public:
  using Entry = std::pair<Key, Value>;

 private:
  struct Record {
    Entry entry;
    std::uint64_t insertion_identity;
  };

  struct Storage {
    std::vector<Record> records;
    std::uint64_t next_insertion_identity = 0;
  };

 public:
  class const_iterator {
   public:
    using difference_type = typename std::vector<Record>::difference_type;
    using iterator_category = std::forward_iterator_tag;
    using pointer = const Entry*;
    using reference = const Entry&;
    using value_type = Entry;

    const_iterator() = default;

    [[nodiscard]] reference operator*() const noexcept { return iterator_->entry; }
    [[nodiscard]] pointer operator->() const noexcept { return &iterator_->entry; }

    const_iterator& operator++() noexcept {
      ++iterator_;
      return *this;
    }

    const_iterator operator++(int) noexcept {
      auto previous = *this;
      ++*this;
      return previous;
    }

    [[nodiscard]] friend bool operator==(const const_iterator&, const const_iterator&) noexcept = default;

   private:
    friend class Map;
    using RecordIterator = typename std::vector<Record>::const_iterator;

    explicit const_iterator(RecordIterator iterator) noexcept : iterator_(iterator) {}

    RecordIterator iterator_{};
  };

  using size_type = typename std::vector<Record>::size_type;

  Map() : storage_(std::make_shared<Storage>()) {}

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

  [[nodiscard]] const_iterator begin() const noexcept {
    return const_iterator(storage_->records.cbegin());
  }

  [[nodiscard]] const_iterator end() const noexcept {
    return const_iterator(storage_->records.cend());
  }

  void clear() noexcept { storage_->records.clear(); }

  [[nodiscard]] Map clone() const {
    Map result;
    *result.storage_ = *storage_;
    return result;
  }

  [[nodiscard]] bool empty() const noexcept { return storage_->records.empty(); }

  template <typename Function>
  void for_each(Function function) const {
    std::vector<std::uint64_t> visited;
    while (true) {
      const auto record = std::find_if(
          storage_->records.cbegin(), storage_->records.cend(), [&](const Record& candidate) {
            return std::find(visited.cbegin(), visited.cend(), candidate.insertion_identity) ==
                   visited.cend();
          });
      if (record == storage_->records.cend()) return;

      const auto identity = record->insertion_identity;
      const auto entry = record->entry;
      visited.push_back(identity);
      std::invoke(function, entry.second, entry.first);
    }
  }

  bool erase(const Key& key) {
    const auto entry = find(key);
    if (entry == storage_->records.end()) return false;
    storage_->records.erase(entry);
    return true;
  }

  [[nodiscard]] std::optional<Value> get(const Key& key) const {
    const auto entry = find(key);
    if (entry == storage_->records.end()) return std::nullopt;
    return entry->entry.second;
  }

  [[nodiscard]] bool has(const Key& key) const { return find(key) != storage_->records.end(); }

  Map& set(Key key, Value value) {
    const auto entry = find(key);
    if (entry == storage_->records.end()) {
      if (storage_->next_insertion_identity == std::numeric_limits<std::uint64_t>::max()) {
        throw std::length_error("flight::Map exhausted insertion identities");
      }
      if constexpr (std::floating_point<Key>) {
        if (key == Key{0}) key = Key{0};
      }
      storage_->records.push_back(
          Record{Entry(std::move(key), std::move(value)), storage_->next_insertion_identity});
      ++storage_->next_insertion_identity;
    } else {
      entry->entry.second = std::move(value);
    }
    return *this;
  }

  [[nodiscard]] size_type size() const noexcept { return storage_->records.size(); }

 private:
  [[nodiscard]] auto find(const Key& key) {
    return std::find_if(storage_->records.begin(), storage_->records.end(), [&](const Record& record) {
      return equal_(record.entry.first, key);
    });
  }

  [[nodiscard]] auto find(const Key& key) const {
    return std::find_if(storage_->records.cbegin(), storage_->records.cend(), [&](const Record& record) {
      return equal_(record.entry.first, key);
    });
  }

  Equal equal_{};
  std::shared_ptr<Storage> storage_;
};

} // namespace flight
