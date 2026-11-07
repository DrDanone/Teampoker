import { LogoError, MAX_LOGO_BYTES } from '../branding/logo.js';
import {
  HttpError,
  clientIp,
  isHttps,
  parseCookies,
  readJson,
  readRaw,
  sendJson,
} from '../http.js';
import { FailureLimiter } from '../ratelimit.js';
import { RoomError } from '../rooms/store.js';
import { ABSOLUTE_TIMEOUT_MS, SESSION_COOKIE, SessionStore, safeEqual } from './sessions.js';

const API_PREFIX = '/api/admin';
const ROOM_PATH = /^\/api\/admin\/rooms\/([A-Za-z0-9-]{1,64})$/;
const ROOM_CODE_PATH = /^\/api\/admin\/rooms\/([A-Za-z0-9-]{1,64})\/code$/;

/**
 * Admin-API unter /api/admin.
 *
 * @param {object} options
 * @param {import('../rooms/store.js').RoomStore} options.rooms
 * @param {import('../branding/logo.js').LogoStore} options.logo
 * @param {string} options.adminPassword
 * @param {SessionStore} [options.sessions]
 * @param {FailureLimiter} [options.loginLimiter]
 */
export function createAdminApi({
  rooms,
  logo,
  adminPassword,
  sessions = new SessionStore(),
  loginLimiter = new FailureLimiter(),
}) {
  /** @returns {Promise<boolean>} ob die Anfrage behandelt wurde */
  return async function handleAdminApi(req, res, pathname) {
    if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) return false;

    try {
      await route(req, res, pathname);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message }, error.headers);
      } else if (error instanceof LogoError) {
        sendJson(res, 400, { error: error.message });
      } else if (error instanceof RoomError) {
        sendJson(res, error.code === 'not-found' ? 404 : 400, { error: error.message });
      } else {
        throw error;
      }
    }
    return true;
  };

  async function route(req, res, pathname) {
    const { method } = req;

    if (pathname === `${API_PREFIX}/login` && method === 'POST') return login(req, res);
    if (pathname === `${API_PREFIX}/session` && method === 'GET') return sessionInfo(req, res);

    const session = requireSession(req);

    if (pathname === `${API_PREFIX}/logout` && method === 'POST') {
      requireCsrf(req, session);
      sessions.destroy(session.id);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(req) });
    }

    if (pathname === `${API_PREFIX}/logo`) {
      if (method === 'PUT') {
        requireCsrf(req, session);
        const data = await readRaw(req, MAX_LOGO_BYTES, 'Das Logo darf höchstens 1 MB groß sein');
        const saved = await logo.save(data, req.headers['content-type']);
        return sendJson(res, 200, { logo: logoInfo(saved) });
      }
      if (method === 'DELETE') {
        requireCsrf(req, session);
        await logo.remove();
        return sendJson(res, 200, { logo: null });
      }
      throw methodNotAllowed('PUT, DELETE');
    }

    if (pathname === `${API_PREFIX}/rooms`) {
      if (method === 'GET') return sendJson(res, 200, { rooms: rooms.list() });
      if (method === 'POST') {
        requireCsrf(req, session);
        const { name } = await readJson(req);
        return sendJson(res, 201, { room: await rooms.create(name) });
      }
      throw methodNotAllowed('GET, POST');
    }

    let match = pathname.match(ROOM_PATH);
    if (match) {
      const id = match[1];
      if (method === 'PATCH') {
        requireCsrf(req, session);
        const { name } = await readJson(req);
        return sendJson(res, 200, { room: await rooms.rename(id, name) });
      }
      if (method === 'DELETE') {
        requireCsrf(req, session);
        await rooms.delete(id);
        return sendJson(res, 200, { ok: true });
      }
      throw methodNotAllowed('PATCH, DELETE');
    }

    match = pathname.match(ROOM_CODE_PATH);
    if (match) {
      if (method !== 'POST') throw methodNotAllowed('POST');
      requireCsrf(req, session);
      return sendJson(res, 200, { room: await rooms.regenerateCode(match[1]) });
    }

    throw new HttpError(404, 'Nicht gefunden');
  }

  async function login(req, res) {
    requireSameOrigin(req);
    const ip = clientIp(req);
    const lockedMs = loginLimiter.lockedFor(ip);
    if (lockedMs > 0) throw tooManyAttempts(lockedMs);

    const { password } = await readJson(req);
    if (!safeEqual(password, adminPassword)) {
      loginLimiter.recordFailure(ip);
      const nowLocked = loginLimiter.lockedFor(ip);
      if (nowLocked > 0) throw tooManyAttempts(nowLocked);
      throw new HttpError(401, 'Passwort falsch');
    }

    loginLimiter.reset(ip);
    // Eine eventuell vorhandene alte Sitzung beenden (Session Fixation).
    const previous = parseCookies(req)[SESSION_COOKIE];
    if (previous) sessions.destroy(previous);

    const session = sessions.create();
    sendJson(
      res,
      200,
      { authenticated: true, csrfToken: session.csrfToken },
      { 'Set-Cookie': sessionCookie(req, session.id) },
    );
  }

  function sessionInfo(req, res) {
    const session = currentSession(req);
    if (!session) return sendJson(res, 200, { authenticated: false });
    sendJson(res, 200, { authenticated: true, csrfToken: session.csrfToken });
  }

  function currentSession(req) {
    return sessions.get(parseCookies(req)[SESSION_COOKIE]);
  }

  function requireSession(req) {
    const session = currentSession(req);
    if (!session) throw new HttpError(401, 'Nicht angemeldet');
    return session;
  }
}

/** Schutz gegen CSRF: CSRF-Token im Header und gleiche Herkunft. */
function requireCsrf(req, session) {
  requireSameOrigin(req);
  if (!safeEqual(String(req.headers['x-csrf-token'] ?? ''), session.csrfToken)) {
    throw new HttpError(403, 'Ungültiges CSRF-Token');
  }
}

/** Lehnt Anfragen ab, deren Origin-Header nicht zum Host passt. */
function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Ungültige Herkunft');
  }
  if (host !== req.headers.host) throw new HttpError(403, 'Ungültige Herkunft');
}

function sessionCookie(req, id) {
  const maxAge = Math.floor(ABSOLUTE_TIMEOUT_MS / 1000);
  const secure = isHttps(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function clearCookie(req) {
  const secure = isHttps(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

/** Öffentliche Angaben zum Logo; die Version im Link umgeht alte Caches. */
export function logoInfo(current) {
  if (!current) return null;
  return { url: `/logo?v=${encodeURIComponent(current.etag.replaceAll('"', ''))}` };
}

function methodNotAllowed(allow) {
  return new HttpError(405, 'Methode nicht erlaubt', { Allow: allow });
}

function tooManyAttempts(lockedMs) {
  const seconds = Math.ceil(lockedMs / 1000);
  const minutes = Math.ceil(seconds / 60);
  return new HttpError(
    429,
    `Zu viele Fehlversuche. Bitte in ${minutes} Minute${minutes === 1 ? '' : 'n'} erneut versuchen.`,
    { 'Retry-After': String(seconds) },
  );
}
