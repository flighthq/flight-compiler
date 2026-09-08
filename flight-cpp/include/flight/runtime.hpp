#pragma once

#include <flight/array.hpp>
#include <flight/contract.hpp>
#include <flight/date.hpp>
#include <flight/equality.hpp>
#include <flight/error.hpp>
#include <flight/executor.hpp>
#include <flight/host.hpp>
#include <flight/map.hpp>
#include <flight/math.hpp>
#include <flight/presence.hpp>
#include <flight/rejection.hpp>
#include <flight/set.hpp>
#include <flight/string.hpp>
#include <flight/task.hpp>
#include <flight/typed_array.hpp>
#include <flight/version.hpp>

template <typename Value>
using FlightTask = flight::Task<Value>;

using FlightDate = flight::Date;
