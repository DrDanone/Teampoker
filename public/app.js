// Oberfläche für Teilnehmer. Alle Texte werden über textContent gesetzt, nie als HTML.

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
};

function setStatus(text, isError = false) {
  const status = $('#status');
  status.textContent = text;
  status.classList.toggle('status-error', isError);
}

function showJoin({ code = '', message = '', isError = false } = {}) {
  state.joined = false;
  $('#join-view').hidden = false;
  $('#room-view').hidden = true;
  $('#room-title').textContent = '';
  if (code) $('#code').value = code;
  $('#name').value ||= storage.get(NAME_KEY) ?? '';
  setStatus(message, isError);
  ($('#code').value ? $('#name') : $('#code')).focus();
}

function showRoom() {
  $('#join-view').hidden = true;
  $('#room-view').hidden = false;
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

function renderState({ room, participants }) {
  $('#room-title').textContent = room.name;
  document.title = `${room.name} – Wilkenpoker`;
  const list = $('#participants');
  list.replaceChildren(
    ...participants.map((participant) => {
      const item = document.createElement('li');
      item.className = 'participant';
      item.classList.toggle('offline', !participant.online);
      item.classList.toggle('you', participant.id === state.you);
      item.textContent = participant.name;
      if (participant.id === state.you) item.append(suffix(' (du)'));
      if (!participant.online) item.append(suffix(' – offline'));
      return item;
    }),
  );
}

function suffix(text) {
  const span = document.createElement('span');
  span.className = 'suffix';
  span.textContent = text;
  return span;
}

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
