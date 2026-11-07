/**
 * Zählt Fehlversuche pro Schlüssel (z. B. IP-Adresse) und sperrt den
 * Schlüssel, wenn innerhalb von `windowMs` mehr als `maxFailures`
 * Fehlversuche auftreten.
 */
export class FailureLimiter {
  /** @type {Map<string, { count: number, firstAt: number, lockedUntil: number }>} */
  #entries = new Map();
  #maxFailures;
  #windowMs;
  #lockMs;
  #now;
  #maxEntries;

  constructor({
    maxFailures = 5,
    windowMs = 15 * 60_000,
    lockMs = 15 * 60_000,
    now = Date.now,
    maxEntries = 10_000,
  } = {}) {
    this.#maxFailures = maxFailures;
    this.#windowMs = windowMs;
    this.#lockMs = lockMs;
    this.#now = now;
    this.#maxEntries = maxEntries;
  }

  /** @returns {number} verbleibende Sperrzeit in Millisekunden (0 = frei) */
  lockedFor(key) {
    const entry = this.#entries.get(key);
    if (!entry) return 0;
    return Math.max(0, entry.lockedUntil - this.#now());
  }

  recordFailure(key) {
    const now = this.#now();
    let entry = this.#entries.get(key);
    if (!entry || (now - entry.firstAt > this.#windowMs && entry.lockedUntil <= now)) {
      entry = { count: 0, firstAt: now, lockedUntil: 0 };
      this.#entries.set(key, entry);
      this.#prune(now);
    }
    entry.count += 1;
    if (entry.count >= this.#maxFailures) entry.lockedUntil = now + this.#lockMs;
  }

  reset(key) {
    this.#entries.delete(key);
  }

  /** Anzahl gespeicherter Einträge (für Tests und Monitoring). */
  get size() {
    return this.#entries.size;
  }

  /** Entfernt abgelaufene Einträge, damit der Speicher nicht unbegrenzt wächst. */
  #prune(now) {
    if (this.#entries.size <= this.#maxEntries) return;
    for (const [key, entry] of this.#entries) {
      if (now - entry.firstAt > this.#windowMs && entry.lockedUntil <= now) {
        this.#entries.delete(key);
      }
    }
    // Wird es trotzdem zu viel, fallen die ältesten Einträge heraus.
    for (const key of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries) break;
      this.#entries.delete(key);
    }
  }
}
