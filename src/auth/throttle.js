// Login throttling (Rulebook §2.1). After too many failed attempts for one
// username or from one IP address, further attempts are refused until the
// window expires, which makes guessing an organizer's password impractical.
// Each key has its own maximum: a whole school Wi-Fi can share one address,
// so the address limit is set higher than the username limit.

export function createThrottle() {
  const failures = new Map(); // key -> { count, resetAt }

  function current(key, now) {
    const entry = failures.get(key);
    if (entry && entry.resetAt <= now) {
      failures.delete(key);
      return null;
    }
    return entry;
  }

  return {
    /** limits: [{ key, max }] — blocked if any key reached its maximum. */
    isBlocked(limits, now) {
      return limits.some(({ key, max }) => (current(key, now)?.count ?? 0) >= max);
    },

    recordFailure(keys, { windowMs, now }) {
      for (const key of keys) {
        const entry = current(key, now) ?? { count: 0, resetAt: now + windowMs };
        entry.count += 1;
        failures.set(key, entry);
      }
      if (failures.size > 10_000) {
        for (const [key, entry] of failures) if (entry.resetAt <= now) failures.delete(key);
      }
    },

    reset(key) {
      failures.delete(key);
    },
  };
}
