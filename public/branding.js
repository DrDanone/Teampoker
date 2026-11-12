// Zeigt das vom Superadmin hochgeladene Logo oben links an (statt der Purple-Kurve)
// und verwaltet den Seitennamen. Der Name steht schon im HTML (vom Server
// eingesetzt), damit beim Laden nichts flackert.

const DEFAULT_SITE_NAME = 'Teampoker';

/** Der aktuell angezeigte Seitenname. */
export function siteName() {
  return document.querySelector('#site-name')?.textContent.trim() || DEFAULT_SITE_NAME;
}

/** Setzt den Seitennamen oben links (nur als Text, nie als HTML). */
export function showSiteName(name) {
  const element = document.querySelector('#site-name');
  if (element) element.textContent = name;
}

/** @param {{ url: string } | null} logo */
export function showLogo(logo) {
  const slot = document.querySelector('#logo-slot');
  if (!slot) return;
  // Mit Logo ersetzt es die Purple-Kurve oben links.
  document.querySelector('.topbar')?.classList.toggle('has-logo', Boolean(logo));
  if (!logo) {
    slot.replaceChildren();
    return;
  }
  const img = document.createElement('img');
  img.className = 'logo';
  img.alt = 'Logo';
  img.src = logo.url;
  img.addEventListener('error', () => {
    img.remove();
    document.querySelector('.topbar')?.classList.remove('has-logo');
  });
  slot.replaceChildren(img);
}

export async function loadBranding() {
  try {
    const res = await fetch('/api/branding');
    if (!res.ok) return;
    const { logo } = await res.json();
    showLogo(logo);
  } catch {
    // Ohne Logo weiter
  }
}
