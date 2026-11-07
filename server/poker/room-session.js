import { randomBytes, randomUUID } from 'node:crypto';

import { safeEqual } from '../admin/sessions.js';
import { evaluate, isCard } from './cards.js';
import { PokerError, cleanParticipantName, nameKey } from './names.js';

export const MAX_PARTICIPANTS = 30;

/**
 * @typedef {object} Participant
 * @property {string} id         öffentliche ID (wird an alle verschickt)
 * @property {string} name
 * @property {string} token      geheimes Wiederkehr-Token (nur der Teilnehmer kennt es)
 * @property {Set<object>} sockets offene Verbindungen (mehrere Tabs möglich)
 * @property {number} joinedAt
 * @property {number | null} offlineSince
 * @property {string | null} vote gewählte Karte der laufenden Runde
 */

/**
 * Laufender Zustand eines Raums im Arbeitsspeicher: wer ist da, wer ist
 * online, wer hat was geschätzt. Nichts davon wird gespeichert.
 */
export class RoomSession {
  /** @type {Map<string, Participant>} */
  participants = new Map();
  /** Nummer der Runde; steigt mit jedem Zurücksetzen. */
  round = 1;
  revealed = false;
  #now;
  #maxParticipants;

  constructor(roomId, { now = Date.now, maxParticipants = MAX_PARTICIPANTS } = {}) {
    this.roomId = roomId;
    this.#now = now;
    this.#maxParticipants = maxParticipants;
  }

  /**
   * Nimmt einen Teilnehmer auf oder holt ihn zurück.
   *
   * - Passendes Token → derselbe Teilnehmer (auch nach Neuladen), Name wird aktualisiert.
   * - Name ist frei → neuer Teilnehmer.
   * - Name gehört jemandem, der offline ist → wird übernommen (z. B. Gerätewechsel).
   * - Name gehört jemandem, der online ist → abgelehnt.
   *
   * @returns {Participant}
   */
  join({ name, token }) {
    const cleanName = cleanParticipantName(name);
    const existing = this.#findByToken(token);
    const sameName = this.#findByName(cleanName);

    if (existing) {
      if (sameName && sameName !== existing) {
        if (isOnline(sameName)) throw nameTaken();
        this.#remove(sameName);
      }
      existing.name = cleanName;
      return existing;
    }

    if (sameName) {
      if (isOnline(sameName)) throw nameTaken();
      sameName.token = newToken();
      sameName.name = cleanName;
      return sameName;
    }

    if (this.participants.size >= this.#maxParticipants) {
      throw new PokerError('room-full', `Der Raum ist voll (höchstens ${this.#maxParticipants})`);
    }

    /** @type {Participant} */
    const participant = {
      id: randomUUID(),
      name: cleanName,
      token: newToken(),
      sockets: new Set(),
      joinedAt: this.#now(),
      offlineSince: this.#now(),
      vote: null,
    };
    this.participants.set(participant.id, participant);
    return participant;
  }

  attach(participant, socket) {
    participant.sockets.add(socket);
    participant.offlineSince = null;
  }

  /** @returns {boolean} ob der Teilnehmer dadurch offline gegangen ist */
  detach(participant, socket) {
    if (!participant.sockets.delete(socket)) return false;
    if (participant.sockets.size > 0) return false;
    participant.offlineSince = this.#now();
    return true;
  }

  leave(participantId) {
    const participant = this.participants.get(participantId);
    if (participant) this.#remove(participant);
    return participant ?? null;
  }

  /**
   * Entfernt Teilnehmer, die länger als `offlineTimeoutMs` offline sind.
   *
   * @returns {Participant[]} entfernte Teilnehmer
   */
  removeStale(offlineTimeoutMs) {
    const now = this.#now();
    const removed = [];
    for (const participant of this.participants.values()) {
      if (participant.offlineSince !== null && now - participant.offlineSince >= offlineTimeoutMs) {
        this.#remove(participant);
        removed.push(participant);
      }
    }
    return removed;
  }

  /**
   * Setzt oder entfernt (`null`) die Karte eines Teilnehmers.
   * Nach dem Aufdecken sind die Karten gesperrt.
   */
  vote(participant, value) {
    if (this.revealed) {
      throw new PokerError(
        'locked',
        'Die Karten sind aufgedeckt. Erst zurücksetzen, dann neu schätzen.',
      );
    }
    if (value !== null && !isCard(value)) {
      throw new PokerError('invalid-message', 'Diese Karte gibt es nicht');
    }
    participant.vote = value;
  }

  /**
   * Deckt die Karten der Runde `round` auf.
   *
   * @returns {boolean} ob sich etwas geändert hat (doppelte Klicks und
   *   veraltete Runden werden ignoriert)
   */
  reveal(round) {
    if (round !== this.round || this.revealed) return false;
    this.revealed = true;
    return true;
  }

  /**
   * Löscht alle Schätzungen und beginnt eine neue Runde, sofern `round`
   * die aktuelle ist – so führen gleichzeitige Klicks nur zu einem Reset.
   *
   * @returns {boolean} ob sich etwas geändert hat
   */
  reset(round) {
    if (round !== this.round) return false;
    for (const participant of this.participants.values()) participant.vote = null;
    this.revealed = false;
    this.round += 1;
    return true;
  }

  /**
   * Zustand aus Sicht eines Teilnehmers. Vor dem Aufdecken enthält er nur,
   * **ob** jemand gewählt hat – die eigene Karte ausgenommen.
   *
   * @param {Participant | null} viewer
   */
  stateFor(viewer) {
    const participants = this.publicParticipants().map((p) => {
      const { vote } = this.participants.get(p.id);
      return {
        ...p,
        voted: vote !== null,
        ...(this.revealed ? { vote } : {}),
      };
    });
    return {
      round: this.round,
      revealed: this.revealed,
      participants,
      yourVote: viewer?.vote ?? null,
      result: this.revealed
        ? evaluate([...this.participants.values()].map(({ id, vote }) => ({ id, vote })))
        : null,
    };
  }

  get isEmpty() {
    return this.participants.size === 0;
  }

  /** Alle offenen Verbindungen des Raums. */
  *sockets() {
    for (const participant of this.participants.values()) yield* participant.sockets;
  }

  /** Öffentliche Teilnehmerliste in Beitrittsreihenfolge – ohne Tokens. */
  publicParticipants() {
    return [...this.participants.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({ id: p.id, name: p.name, online: isOnline(p) }));
  }

  #findByToken(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    for (const participant of this.participants.values()) {
      if (safeEqual(participant.token, token)) return participant;
    }
    return null;
  }

  #findByName(name) {
    const key = nameKey(name);
    for (const participant of this.participants.values()) {
      if (nameKey(participant.name) === key) return participant;
    }
    return null;
  }

  #remove(participant) {
    this.participants.delete(participant.id);
  }
}

function isOnline(participant) {
  return participant.sockets.size > 0;
}

function newToken() {
  return randomBytes(32).toString('base64url');
}

function nameTaken() {
  return new PokerError('name-taken', 'Dieser Name ist im Raum schon vergeben');
}
