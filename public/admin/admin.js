// Verwaltung der Räume durch den Superadmin.
// Alle Texte werden über textContent gesetzt, nie als HTML.

import { loadBranding, showLogo, showSiteName } from '../branding.js';

const $ = (selector) => document.querySelector(selector);

const LOGO_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

let csrfToken = '';
/** Öffentliche Adresse für Einladungslinks (PUBLIC_URL), sonst die aktuelle. */
let publicUrl = '';

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    showLogin('Bitte erneut anmelden.');
    throw new Error('Nicht angemeldet');
  }
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

function setStatus(text, isError = false) {
  const status = $('#status');
  status.replaceChildren();
  if (text && isError) {
    const icon = document.createElement('span');
    icon.className = 'icon icon-close';
    icon.setAttribute('aria-hidden', 'true');
    status.append(icon);
  }
  if (text) status.append(text);
  status.classList.toggle('status-error', isError);
}

function showLogin(message = '') {
  csrfToken = '';
  $('#login-view').hidden = false;
  $('#admin-view').hidden = true;
  $('#logout').hidden = true;
  setStatus(message, Boolean(message));
  $('#password').focus();
}

async function showRooms() {
  $('#login-view').hidden = true;
  $('#admin-view').hidden = false;
  $('#logout').hidden = false;
  await Promise.all([loadRooms(), loadLogo()]);
}

async function loadRooms() {
  const { rooms } = await api('GET', '/rooms');
  const list = $('#rooms');
  list.replaceChildren(...rooms.map(renderRoom));
  $('#empty').hidden = rooms.length > 0;
}

async function loadLogo() {
  const res = await fetch('/api/branding');
  const { logo, name } = await res.json();
  renderLogo(logo);
  renderSiteName(name);
}

function renderSiteName(name) {
  showSiteName(name);
  document.title = `Verwaltung – ${name}`;
  $('#site-name-input').value = name;
}

$('#name-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const { name } = await api('PUT', '/name', { name: $('#site-name-input').value });
    renderSiteName(name);
    setStatus(`Name der Seite: „${name}“.`);
  } catch (error) {
    setStatus(error.message, true);
  }
});

function renderLogo(logo) {
  const preview = $('#logo-preview');
  preview.hidden = !logo;
  if (logo) preview.src = logo.url;
  else preview.removeAttribute('src');
  $('#logo-none').hidden = Boolean(logo);
  $('#logo-remove').hidden = !logo;
  showLogo(logo);
}

$('#logo-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = $('#logo-file').files[0];
  if (!file) return;
  // Manche Browser liefern für SVG keinen oder einen anderen Typ – dann nach Endung.
  const extension = file.name.split('.').pop().toLowerCase();
  const type = LOGO_TYPES[extension] ?? file.type;
  try {
    const res = await fetch('/api/admin/logo', {
      method: 'PUT',
      headers: { 'content-type': type, 'x-csrf-token': csrfToken },
      body: file,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) return showLogin('Bitte erneut anmelden.');
    if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
    renderLogo(data.logo);
    $('#logo-file').value = '';
    setStatus('Logo gespeichert.');
  } catch (error) {
    setStatus(error.message, true);
  }
});

$('#logo-remove').addEventListener('click', async () => {
  try {
    await api('DELETE', '/logo');
    renderLogo(null);
    setStatus('Logo entfernt.');
  } catch (error) {
    setStatus(error.message, true);
  }
});

function inviteLink(code) {
  return `${publicUrl || location.origin}/join/${code}`;
}

function renderRoom(room) {
  const item = $('#room-template').content.firstElementChild.cloneNode(true);
  item.dataset.id = room.id;
  item.querySelector('.room-name').textContent = room.name;
  item.querySelector('.room-created').textContent =
    `angelegt am ${new Date(room.createdAt).toLocaleDateString('de-DE')}`;
  item.querySelector('.code').textContent = room.code;

  const confirmBox = item.querySelector('.confirm');
  const renameForm = item.querySelector('.rename-form');
  let pending = null;

  function askConfirm(text, action) {
    pending = action;
    confirmBox.querySelector('.confirm-text').textContent = text;
    confirmBox.hidden = false;
    confirmBox.querySelector('[data-action="cancel"]').focus();
  }

  item.addEventListener('click', async (event) => {
    const action = event.target.closest('button')?.dataset.action;
    if (!action) return;
    try {
      switch (action) {
        case 'copy-code':
          await copy(room.code, 'Code kopiert.');
          break;
        case 'copy-link':
          await copy(inviteLink(room.code), 'Einladungslink kopiert.');
          break;
        case 'rename':
          renameForm.hidden = false;
          renameForm.elements.name.value = room.name;
          renameForm.elements.name.focus();
          break;
        case 'cancel-rename':
          renameForm.hidden = true;
          break;
        case 'regenerate':
          askConfirm(
            `Neuen Code für „${room.name}“ erzeugen? Der alte Code funktioniert danach nicht mehr.`,
            async () => {
              await api('POST', `/rooms/${room.id}/code`);
              setStatus(`Neuer Code für „${room.name}“ erzeugt.`);
            },
          );
          break;
        case 'delete':
          askConfirm(`Raum „${room.name}“ endgültig löschen?`, async () => {
            await api('DELETE', `/rooms/${room.id}`);
            setStatus(`Raum „${room.name}“ gelöscht.`);
          });
          break;
        case 'cancel':
          pending = null;
          confirmBox.hidden = true;
          break;
        case 'confirm':
          confirmBox.hidden = true;
          if (pending) {
            const run = pending;
            pending = null;
            await run();
            await loadRooms();
          }
          break;
      }
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  renameForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('PATCH', `/rooms/${room.id}`, { name: renameForm.elements.name.value });
      setStatus('Raum umbenannt.');
      await loadRooms();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  return item;
}

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(message);
  } catch {
    setStatus(`Kopieren nicht möglich – bitte manuell kopieren: ${text}`, true);
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#password');
  try {
    const data = await api('POST', '/login', { password: input.value });
    csrfToken = data.csrfToken;
    publicUrl = data.publicUrl ?? '';
    input.value = '';
    setStatus('');
    await showRooms();
  } catch (error) {
    setStatus(error.message, true);
    input.select();
  }
});

$('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#room-name');
  try {
    const { room } = await api('POST', '/rooms', { name: input.value });
    input.value = '';
    setStatus(`Raum „${room.name}“ angelegt. Code: ${room.code}`);
    await loadRooms();
  } catch (error) {
    setStatus(error.message, true);
  }
});

$('#logout').addEventListener('click', async () => {
  try {
    await api('POST', '/logout');
  } finally {
    showLogin('Abgemeldet.');
    $('#status').classList.remove('status-error');
  }
});

async function init() {
  loadBranding();
  try {
    const session = await api('GET', '/session');
    if (session.authenticated) {
      csrfToken = session.csrfToken;
      publicUrl = session.publicUrl ?? '';
      await showRooms();
    } else {
      showLogin();
    }
  } catch (error) {
    setStatus(error.message, true);
  }
}

init();
