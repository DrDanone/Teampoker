// Oberfläche für Teilnehmer. Alle Texte werden über textContent gesetzt, nie als HTML.

import { loadBranding } from './branding.js';

const $ = (selector) => document.querySelector(selector);

const NAME_KEY = 'wilkenpoker:name';
const SESSION_KEY = 'wilkenpoker:session';
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10000];

/** localStorage kann gesperrt sein (z. B. privater Modus) – dann ohne Merken. */
const storage = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignorieren
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignorieren
    }
  },
};

const state = {
  socket: null,
  /** @type {{ code: string, name: string, token?: string } | null} */
  session: null,
  you: null,
  reconnectAttempt: 0,
  reconnectTimer: null,
  joined: false,
  round: 1,
  revealed: false,
  /** @type {string | null} */
  yourVote: null,
};

function setStatus(text, isError = false) {
  for (const status of document.querySelectorAll('.status')) {
    status.replaceChildren();
    if (text && isError) status.append(icon('close'));
    if (text) status.append(text);
    status.classList.toggle('status-error', isError);
  }
}

/** Material-Symbols-Icon als dekoratives Element. */
function icon(name) {
  const span = document.createElement('span');
  span.className = `icon icon-${name.replaceAll('_', '-')}`;
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function initials(name) {
  const parts = name.split(' ').filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts.at(-1)] : [parts[0] ?? '?'];
  return letters.map((part) => [...part][0].toLocaleUpperCase('de')).join('');
}

function showJoin({ code = '', message = '', isError = false } = {}) {
  state.joined = false;
  $('#join-view').hidden = false;
  $('#room-view').hidden = true;
  $('#room-title').textContent = '';
  $('#leave').hidden = true;
  document.title = 'Wilkenpoker';
  if (code) $('#code').value = code;
  $('#name').value ||= storage.get(NAME_KEY) ?? '';
  setStatus(message, isError);
  ($('#code').value ? $('#name') : $('#code')).focus();
}

function showRoom() {
  $('#join-view').hidden = true;
  $('#room-view').hidden = false;
  $('#leave').hidden = false;
}

function connect() {
  clearTimeout(state.reconnectTimer);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket;

  socket.addEventListener('open', () => {
    state.reconnectAttempt = 0;
    if (state.session) send({ type: 'join', ...state.session });
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleMessage(message);
  });

  socket.addEventListener('close', () => {
    if (state.socket !== socket) return;
    state.socket = null;
    state.joined = false;
    if (!state.session) return;
    // Unerwartet getrennt: erneut verbinden, Teilnehmer bleibt erhalten.
    setStatus('Verbindung unterbrochen – verbinde neu …', true);
    markAllOffline();
    const delay =
      RECONNECT_DELAYS_MS[Math.min(state.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    state.reconnectAttempt += 1;
    state.reconnectTimer = setTimeout(connect, delay);
  });
}

function send(payload) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(payload));
}

function handleMessage(message) {
  switch (message.type) {
    case 'joined':
      state.you = message.you;
      state.joined = true;
      state.session = { ...state.session, token: message.token };
      storage.set(SESSION_KEY, state.session);
      storage.set(NAME_KEY, state.session.name);
      setStatus('');
      showRoom();
      break;
    case 'state':
      renderState(message);
      break;
    case 'left':
      endSession({ message: 'Du hast den Raum verlassen.' });
      break;
    case 'kicked':
      endSession({ message: message.message, isError: true });
      break;
    case 'error':
      handleError(message);
      break;
  }
}

function handleError({ code, message }) {
  if (!state.joined) {
    // Beitritt gescheitert: Wiederkehr-Daten verwerfen, Formular zeigen.
    const failed = state.session;
    state.session = null;
    storage.remove(SESSION_KEY);
    showJoin({ code: failed?.code ?? '', message, isError: true });
    if (code === 'invalid-code') $('#code').select();
    if (code === 'invalid-name' || code === 'name-taken') $('#name').select();
    return;
  }
  setStatus(message, true);
}

function endSession({ message, isError = false }) {
  const code = state.session?.code ?? '';
  state.session = null;
  state.you = null;
  storage.remove(SESSION_KEY);
  showJoin({ code: isError ? '' : code, message, isError });
}

function renderState({ room, round, revealed, participants, yourVote, result }) {
  state.round = round;
  state.revealed = revealed;
  state.yourVote = yourVote;

  $('#room-title').textContent = room.name;
  document.title = `${room.name} – Wilkenpoker`;
  $('#round-title').textContent = `Runde ${round}`;

  const voted = participants.filter((p) => p.voted).length;
  $('#progress').textContent = revealed
    ? 'aufgedeckt'
    : `${voted} von ${participants.length} ${participants.length === 1 ? 'hat' : 'haben'} gewählt`;

  renderCards();
  $('#reveal').disabled = revealed;
  $('#cards-hint').textContent = revealed
    ? 'Die Karten sind aufgedeckt. „Alle zurücksetzen“ startet die nächste Runde.'
    : 'Wähle deine Karte. Bis zum Aufdecken kannst du sie ändern.';

  renderResult(result);
  renderParticipants(participants, result);
}

function renderCards() {
  for (const button of document.querySelectorAll('.card')) {
    const selected = button.dataset.value === state.yourVote;
    button.setAttribute('aria-pressed', String(selected));
    button.disabled = state.revealed;
  }
}

function renderResult(result) {
  $('#result').hidden = !result;
  if (!result) return;
  $('#consensus').hidden = !result.consensus;
  $('#stat-average').textContent = formatNumber(result.average);
  $('#stat-median').textContent = formatNumber(result.median);
  $('#stat-spread').textContent =
    result.min === null
      ? '–'
      : result.min === result.max
        ? formatNumber(result.min)
        : `${formatNumber(result.min)} – ${formatNumber(result.max)}`;

  const notes = [];
  if (result.count === 0) notes.push('Keine Zahlen geschätzt.');
  if (result.unsure > 0) notes.push(`${result.unsure}× „?“`);
  if (result.coffee > 0) notes.push(`${result.coffee}× Kaffeepause`);
  if (result.unsure > 0 || result.coffee > 0) notes.push('(nicht in der Statistik)');
  $('#stat-note').textContent = notes.join(' ');
}

function renderParticipants(participants, result) {
  const high = new Set(result?.highIds ?? []);
  const low = new Set(result?.lowIds ?? []);
  $('#participants').replaceChildren(
    ...participants.map((participant) => {
      const item = document.createElement('li');
      item.className = 'participant';
      item.classList.toggle('offline', !participant.online);
      item.classList.toggle('you', participant.id === state.you);
      item.classList.toggle('high', high.has(participant.id));
      item.classList.toggle('low', low.has(participant.id));

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = initials(participant.name);

      const name = document.createElement('span');
      name.className = 'participant-name';
      name.textContent = participant.name;
      if (participant.id === state.you) name.append(suffix(' (du)'));
      if (!participant.online) name.append(suffix(' – offline'));

      const status = document.createElement('span');
      status.className = 'participant-vote';
      if (state.revealed) {
        if (high.has(participant.id)) status.append(outlier('arrow_upward', 'höchster'));
        if (low.has(participant.id)) status.append(outlier('arrow_downward', 'niedrigster'));
        status.append(voteChip(participant.vote));
      } else if (participant.voted) {
        status.append(icon('check'), visuallyHidden('hat gewählt'));
      } else {
        status.classList.add('pending');
        status.append(icon('hourglass_empty'), visuallyHidden('wählt noch'));
      }

      item.append(badge, name, status);
      return item;
    }),
  );
}

function outlier(iconName, label) {
  const span = document.createElement('span');
  span.className = 'outlier';
  span.append(icon(iconName), label);
  return span;
}

function voteChip(vote) {
  const chip = document.createElement('span');
  chip.className = 'vote-chip';
  if (vote === null) {
    chip.classList.add('empty');
    chip.textContent = '–';
    chip.title = 'keine Karte';
  } else {
    chip.append(cardContent(vote));
  }
  return chip;
}

function visuallyHidden(text) {
  const span = document.createElement('span');
  span.className = 'visually-hidden';
  span.textContent = ` ${text}`;
  return span;
}

function suffix(text) {
  const span = document.createElement('span');
  span.className = 'suffix';
  span.textContent = text;
  return span;
}

const CARDS = ['0', '0.5', '1', '2', '3', '5', '8', '13', '20', '40', '100', '?', 'coffee'];

/** Inhalt einer Karte: Zahl, ½, ? oder das Kaffee-Icon. */
function cardContent(value) {
  if (value === 'coffee') {
    const fragment = document.createDocumentFragment();
    fragment.append(icon('coffee'), visuallyHidden('Kaffeepause'));
    return fragment;
  }
  return document.createTextNode(value === '0.5' ? '½' : value);
}

function formatNumber(value) {
  if (value === null || value === undefined) return '–';
  if (value === 0.5) return '½';
  return value.toLocaleString('de-DE', { maximumFractionDigits: 1 });
}

function buildCards() {
  $('#cards').replaceChildren(
    ...CARDS.map((value) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'card';
      button.dataset.value = value;
      button.append(cardContent(value));
      button.setAttribute('aria-pressed', 'false');
      if (value === 'coffee') button.title = 'Kaffeepause';
      if (value === '?') {
        button.title = 'Unsicher';
        button.setAttribute('aria-label', 'Unsicher');
      }
      return button;
    }),
  );
}

$('#cards').addEventListener('click', (event) => {
  const button = event.target.closest('.card');
  if (!button || state.revealed) return;
  // Erneuter Klick auf die gewählte Karte nimmt sie zurück.
  const value = button.dataset.value === state.yourVote ? null : button.dataset.value;
  state.yourVote = value;
  renderCards();
  send({ type: 'vote', value });
});

$('#reveal').addEventListener('click', () => send({ type: 'reveal', round: state.round }));
$('#reset').addEventListener('click', () => send({ type: 'reset', round: state.round }));

function markAllOffline() {
  for (const item of document.querySelectorAll('.participant')) item.classList.add('offline');
}

$('#join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = $('#code').value.replace(/[\s-]/g, '').toUpperCase();
  const name = $('#name').value.trim();
  if (!code) return showJoin({ message: 'Bitte den Raum-Code eingeben.', isError: true });
  if (!name) return showJoin({ code, message: 'Bitte deinen Namen eingeben.', isError: true });

  // Ein gespeichertes Token für denselben Raum mitschicken, damit man
  // als dieselbe Person zurückkommt.
  const previous = storage.get(SESSION_KEY);
  const token = previous?.code === code ? previous.token : undefined;
  state.session = { code, name, token };
  setStatus('Trete bei …');
  if (state.socket?.readyState === WebSocket.OPEN) send({ type: 'join', ...state.session });
  else connect();
});

$('#leave').addEventListener('click', () => send({ type: 'leave' }));

function init() {
  loadBranding();
  buildCards();
  const match = location.pathname.match(/^\/join\/([A-Za-z0-9-]+)\/?$/);
  // Der Code soll nicht in der Adresszeile stehen bleiben (Bildschirmfreigabe im Refinement).
  if (match) history.replaceState(null, '', '/');
  const linkCode = match?.[1].toUpperCase();

  const saved = storage.get(SESSION_KEY);
  if (saved?.code && saved?.name && (!linkCode || linkCode === saved.code)) {
    state.session = saved;
    setStatus('Verbinde …');
    connect();
    return;
  }
  showJoin({ code: linkCode ?? '' });
}

init();
