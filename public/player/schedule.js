// Answers "is this item on at this wall-clock time?" for the TV player and the server.
// Deliberately ES5 with no build step, like player.js. The server loads this same file
// through server/schedule.js.
//
// A schedule is { startDate, endDate, startTime, endTime, days }. All are optional:
//   startDate, endDate  'YYYY-MM-DD', both inclusive
//   startTime, endTime  'HH:MM', set together. The end minute is not included. An end
//                       before the start runs overnight, into the next morning.
//   days                bitmask, Sunday = 1 through Saturday = 64. Empty means every day.
// Dates and days refer to the day a window starts.
//
// A wall-clock time is 'YYYY-MM-DDTHH:MM' or 'YYYY-MM-DDTHH:MM:SS', with no time zone.
// Internally it becomes "wall milliseconds": the same digits read as UTC. That makes the
// arithmetic immune to time zones and daylight saving on whatever device runs this.
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) module.exports = factory();
  else root.SignageSchedule = factory();
})(this, function () {
  'use strict';

  var DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
  var WALL = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
  var DAY_MS = 86400000;

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function empty(value) {
    return value === null || value === undefined;
  }

  // Milliseconds for a real calendar day, or null. Feb 30 rolls over in Date.UTC, so it fails here.
  function dayMs(year, month, day) {
    var ms = Date.UTC(year, month - 1, day);
    var d = new Date(ms);
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return ms;
  }

  function isDate(value) {
    if (typeof value !== 'string') return false;
    var m = DATE.exec(value);
    return !!m && dayMs(+m[1], +m[2], +m[3]) !== null;
  }

  function isTime(value) {
    return typeof value === 'string' && TIME.test(value);
  }

  function minutes(time) {
    return +time.slice(0, 2) * 60 + +time.slice(3, 5);
  }

  function formatDate(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function parseWall(wall) {
    if (typeof wall !== 'string') return null;
    var m = WALL.exec(wall);
    if (!m) return null;
    var day = dayMs(+m[1], +m[2], +m[3]);
    if (day === null) return null;
    return day + (+m[4] * 3600 + +m[5] * 60 + (m[6] ? +m[6] : 0)) * 1000;
  }

  function formatWall(ms) {
    var d = new Date(ms);
    return formatDate(ms) + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
  }

  // This device's own wall clock.
  function localClock(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  function hasSchedule(s) {
    return !empty(s) && (!empty(s.startDate) || !empty(s.endDate) || !empty(s.startTime) || !empty(s.endTime) || !empty(s.days));
  }

  // Why a schedule can't be used, in words for the person setting it, or null if it is fine.
  function problem(s) {
    if (empty(s)) return null;
    if (typeof s !== 'object' || Object.prototype.toString.call(s) !== '[object Object]') return 'That schedule could not be read.';
    if (!empty(s.startDate) && !isDate(s.startDate)) return 'The start date is not a real date. Use a date like 2026-12-25.';
    if (!empty(s.endDate) && !isDate(s.endDate)) return 'The end date is not a real date. Use a date like 2026-12-25.';
    if (!empty(s.startDate) && !empty(s.endDate) && s.endDate < s.startDate) return 'The end date can\'t be before the start date.';
    if (!empty(s.startTime) && !isTime(s.startTime)) return 'The start time must be between 00:00 and 23:59, like 09:30.';
    if (!empty(s.endTime) && !isTime(s.endTime)) return 'The end time must be between 00:00 and 23:59, like 17:00.';
    if (empty(s.startTime) !== empty(s.endTime)) return 'Set both a start time and an end time, or leave both empty.';
    if (!empty(s.startTime) && s.startTime === s.endTime) return 'The start and end time can\'t be the same. Leave both empty to run all day.';
    if (s.days === 0) return 'Pick at least one day. To stop showing this item, turn off "Show this item" instead.';
    if (!empty(s.days) && (typeof s.days !== 'number' || s.days !== Math.floor(s.days) || s.days < 1 || s.days > 127)) {
      return 'The days setting could not be read. Pick the days again.';
    }
    return null;
  }

  function dayAllowed(s, ms) {
    return empty(s.days) || (s.days & (1 << new Date(ms).getUTCDay())) !== 0;
  }

  function dateAllowed(s, ms) {
    var date = formatDate(ms);
    return (empty(s.startDate) || date >= s.startDate) && (empty(s.endDate) || date <= s.endDate);
  }

  function isActive(s, wall) {
    if (problem(s)) return false;
    if (!hasSchedule(s)) return true;
    var now = parseWall(wall);
    if (now === null) return false;
    var today = Math.floor(now / DAY_MS) * DAY_MS;
    var windowDay = today;
    if (!empty(s.startTime)) {
      var at = Math.floor((now - today) / 60000);
      var start = minutes(s.startTime);
      var end = minutes(s.endTime);
      if (start < end) {
        if (at < start || at >= end) return false;
      } else if (at < end) {
        windowDay = today - DAY_MS; // the early part of last night's window
      } else if (at < start) {
        return false;
      }
    }
    return dayAllowed(s, windowDay) && dateAllowed(s, windowDay);
  }

  // 'on', 'scheduled' (a run is still to come), or 'ended' (no run is left).
  function status(s, wall) {
    if (isActive(s, wall)) return 'on';
    var now = parseWall(wall);
    if (problem(s) || now === null) return 'ended';
    var today = Math.floor(now / DAY_MS) * DAY_MS;
    if (dayAllowed(s, today) && dateAllowed(s, today) && !empty(s.startTime) &&
        Math.floor((now - today) / 60000) < minutes(s.startTime)) {
      return 'scheduled';
    }
    // The days repeat weekly, so any run still to come starts within a week of the first possible day.
    var first = today + DAY_MS;
    if (!empty(s.startDate)) {
      var m = DATE.exec(s.startDate);
      first = Math.max(first, dayMs(+m[1], +m[2], +m[3]));
    }
    for (var i = 0; i < 7; i++) {
      var day = first + i * DAY_MS;
      if (dayAllowed(s, day) && dateAllowed(s, day)) return 'scheduled';
    }
    return 'ended';
  }

  return {
    isActive: isActive,
    status: status,
    problem: problem,
    parseWall: parseWall,
    formatWall: formatWall,
    localClock: localClock
  };
});
