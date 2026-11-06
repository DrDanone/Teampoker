import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'wp_admin';
export const IDLE_TIMEOUT_MS = 2 * 60 * 60_000;
export const ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60_000;

/**
 * Admin-Sitzungen im Arbeitsspeicher. Nach einem Neustart muss sich
 * der Superadmin neu anmelden – gewollt.
 */
export class SessionStore {
  /** @type {Map<string, { csrfToken: string, createdAt: number, lastSeen: number }>} */
  #sessions = new Map();
  #now;

  constructor({ now = Date.now } = {}) {
    this.#now = now;
  }

  create() {
    const id = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = this.#now();
    this.#prune(now);
    this.#sessions.set(id, { csrfToken, createdAt: now, lastSeen: now });
    return { id, csrfToken };
  }

  /** Liefert eine gültige Sitzung und verlängert sie, sonst `null`. */
  get(id) {
    if (typeof id !== 'string' || id.length === 0) return null;
    const session = this.#sessions.get(id);
    if (!session) return null;
    const now = this.#now();
    if (isExpired(session, now)) {
      this.#sessions.delete(id);
      return null;
    }
    session.lastSeen = now;
    return { id, csrfToken: session.csrfToken };
  }

  destroy(id) {
    this.#sessions.delete(id);
  }

  #prune(now) {
    for (const [id, session] of this.#sessions) {
      if (isExpired(session, now)) this.#sessions.delete(id);
    }
  }
}

function isExpired(session, now) {
  return now - session.lastSeen > IDLE_TIMEOUT_MS || now - session.createdAt > ABSOLUTE_TIMEOUT_MS;
}

/** Vergleicht zwei Zeichenketten in konstanter Zeit. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB) && a.length === b.length;
}
