import { FailureLimiter } from '../ratelimit.js';
import { PokerError } from './names.js';
import { RoomSession } from './room-session.js';

/** Nach dieser Zeit offline wird ein Teilnehmer aus dem Raum entfernt. */
export const OFFLINE_TIMEOUT_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 30_000;

/** WebSocket-Close-Codes (4000–4999 sind für Anwendungen frei). */
export const CLOSE_CODES = {
  roomDeleted: 4001,
  codeChanged: 4002,
  left: 4003,
  replaced: 4004,
};

/**
 * Verbindet WebSocket-Verbindungen mit Räumen.
 *
 * Protokoll (JSON, Feld `type`):
 * - Client → Server: `join { code, name, token? }`, `leave`, `vote { value }`,
 *   `reveal { round }`, `reset { round }`, `ping`
 * - Server → Client: `joined { you, token, room }`,
 *   `state { room, round, revealed, participants, yourVote, result }`,
 *   `left`, `error { code, message }`, `kicked { reason, message }`, `pong`
 *
 * Vor dem Aufdecken enthält `state` nur, **ob** jemand gewählt hat. Die Werte
 * verlassen den Server erst nach `reveal`.
 */
export class PokerHub {
  /** @type {Map<string, RoomSession>} Raum-ID → Sitzung */
  #sessions = new Map();
  /** @type {Map<object, { session: RoomSession, participant: import('./room-session.js').Participant }>} */
  #bindings = new Map();
  #rooms;
  #now;
  #offlineTimeoutMs;
  #joinLimiter;
  #sweepTimer;
  #unsubscribe;

  /**
   * @param {object} options
   * @param {import('../rooms/store.js').RoomStore} options.rooms
   * @param {() => number} [options.now]
   * @param {number} [options.offlineTimeoutMs]
   * @param {FailureLimiter} [options.joinLimiter] zählt falsche Codes pro IP
   * @param {boolean} [options.autoSweep] regelmäßig aufräumen (in Tests aus)
   */
  constructor({
    rooms,
    now = Date.now,
    offlineTimeoutMs = OFFLINE_TIMEOUT_MS,
    joinLimiter = new FailureLimiter({
      maxFailures: 10,
      windowMs: 10 * 60_000,
      lockMs: 10 * 60_000,
    }),
    autoSweep = true,
  }) {
    this.#rooms = rooms;
    this.#now = now;
    this.#offlineTimeoutMs = offlineTimeoutMs;
    this.#joinLimiter = joinLimiter;

    const onDeleted = (room) =>
      this.#endSession(
        room.id,
        'room-deleted',
        'Der Raum wurde gelöscht.',
        CLOSE_CODES.roomDeleted,
      );
    const onCodeChanged = (room) =>
      this.#endSession(
        room.id,
        'code-changed',
        'Der Raum-Code wurde geändert. Bitte mit dem neuen Code erneut beitreten.',
        CLOSE_CODES.codeChanged,
      );
    const onRenamed = (room) => {
      const session = this.#sessions.get(room.id);
      if (session) this.#broadcast(session);
    };
    rooms.on('deleted', onDeleted);
    rooms.on('codeChanged', onCodeChanged);
    rooms.on('renamed', onRenamed);
    this.#unsubscribe = () => {
      rooms.off('deleted', onDeleted);
      rooms.off('codeChanged', onCodeChanged);
      rooms.off('renamed', onRenamed);
    };

    if (autoSweep) {
      this.#sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
      this.#sweepTimer.unref();
    }
  }

  /** Muss aufgerufen werden, wenn eine Verbindung geschlossen wurde. */
  handleClose(ws) {
    this.#unbind(ws);
  }

  /**
   * Verarbeitet eine bereits als JSON geparste Nachricht.
   *
   * @returns {boolean} ob der Typ bekannt war
   */
  handleMessage(ws, ip, message) {
    try {
      switch (message.type) {
        case 'join':
          this.#join(ws, ip, message);
          return true;
        case 'leave':
          this.#leave(ws);
          return true;
        case 'vote': {
          const { session, participant } = this.#requireBinding(ws);
          const value = message.value === undefined ? null : message.value;
          session.vote(participant, value);
          this.#broadcast(session);
          return true;
        }
        case 'reveal': {
          const { session } = this.#requireBinding(ws);
          if (session.reveal(message.round)) this.#broadcast(session);
          return true;
        }
        case 'reset': {
          const { session } = this.#requireBinding(ws);
          if (session.reset(message.round)) this.#broadcast(session);
          return true;
        }
        default:
          return false;
      }
    } catch (error) {
      if (!(error instanceof PokerError)) throw error;
      send(ws, { type: 'error', code: error.code, message: error.message });
      return true;
    }
  }

  /** Entfernt Teilnehmer, die zu lange offline sind, und leere Räume. */
  sweep() {
    for (const [roomId, session] of this.#sessions) {
      if (session.removeStale(this.#offlineTimeoutMs).length > 0) this.#broadcast(session);
      if (session.isEmpty) this.#sessions.delete(roomId);
    }
  }

  close() {
    clearInterval(this.#sweepTimer);
    this.#unsubscribe();
  }

  /** Für Tests: laufende Sitzung eines Raums. */
  sessionFor(roomId) {
    return this.#sessions.get(roomId) ?? null;
  }

  #join(ws, ip, { code, name, token }) {
    const lockedMs = this.#joinLimiter.lockedFor(ip);
    if (lockedMs > 0) {
      const minutes = Math.ceil(lockedMs / 60_000);
      throw new PokerError(
        'locked',
        `Zu viele falsche Codes. Bitte in ${minutes} Minute${minutes === 1 ? '' : 'n'} erneut versuchen.`,
      );
    }

    const room = this.#rooms.findByCode(code);
    if (!room) {
      this.#joinLimiter.recordFailure(ip);
      throw new PokerError('invalid-code', 'Diesen Raum-Code gibt es nicht');
    }

    // Wer schon in einem Raum ist und erneut beitritt, verlässt die alte Bindung.
    this.#unbind(ws);

    let session = this.#sessions.get(room.id);
    if (!session) {
      session = new RoomSession(room.id, { now: this.#now });
      this.#sessions.set(room.id, session);
    }

    let participant;
    try {
      participant = session.join({ name, token });
    } catch (error) {
      if (session.isEmpty) this.#sessions.delete(room.id);
      throw error;
    }

    session.attach(participant, ws);
    this.#bindings.set(ws, { session, participant });

    send(ws, {
      type: 'joined',
      you: participant.id,
      token: participant.token,
      room: { name: room.name },
    });
    this.#broadcast(session);
  }

  #requireBinding(ws) {
    const binding = this.#bindings.get(ws);
    if (!binding) throw new PokerError('not-joined', 'Du bist in keinem Raum');
    return binding;
  }

  #leave(ws) {
    const { session, participant } = this.#requireBinding(ws);
    session.leave(participant.id);
    for (const socket of participant.sockets) {
      this.#bindings.delete(socket);
      if (socket !== ws) {
        send(socket, { type: 'kicked', reason: 'left', message: 'Du hast den Raum verlassen.' });
        socket.close(CLOSE_CODES.left);
      }
    }
    participant.sockets.clear();
    send(ws, { type: 'left' });
    if (session.isEmpty) this.#sessions.delete(session.roomId);
    else this.#broadcast(session);
  }

  #unbind(ws) {
    const binding = this.#bindings.get(ws);
    if (!binding) return;
    this.#bindings.delete(ws);
    const { session, participant } = binding;
    if (session.detach(participant, ws) && this.#sessions.get(session.roomId) === session) {
      this.#broadcast(session);
    }
  }

  #endSession(roomId, reason, message, closeCode) {
    const session = this.#sessions.get(roomId);
    if (!session) return;
    this.#sessions.delete(roomId);
    for (const socket of [...session.sockets()]) {
      this.#bindings.delete(socket);
      send(socket, { type: 'kicked', reason, message });
      socket.close(closeCode);
    }
  }

  /** Schickt jedem Teilnehmer seinen eigenen Blick auf den Zustand. */
  #broadcast(session) {
    const room = this.#rooms.get(session.roomId);
    if (!room) return;
    for (const participant of session.participants.values()) {
      if (participant.sockets.size === 0) continue;
      const payload = JSON.stringify({
        type: 'state',
        room: { name: room.name },
        ...session.stateFor(participant),
      });
      for (const socket of participant.sockets) {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      }
    }
  }
}

export function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}
