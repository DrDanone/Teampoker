import { randomBytes, randomUUID } from 'node:crypto';

import { safeEqual } from '../admin/sessions.js';
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
 */

/**
 * Laufender Zustand eines Raums im Arbeitsspeicher: wer ist da, wer ist
 * online. Nichts davon wird gespeichert.
 */
export class RoomSession {
  /** @type {Map<string, Participant>} */
  participants = new Map();
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
