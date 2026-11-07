// Zeigt das vom Superadmin hochgeladene Logo oben rechts an.

/** @param {{ url: string } | null} logo */
export function showLogo(logo) {
  const slot = document.querySelector('#logo-slot');
  if (!slot) return;
  if (!logo) {
    slot.replaceChildren();
    return;
  }
  const img = document.createElement('img');
  img.className = 'logo';
  img.alt = 'Logo';
  img.src = logo.url;
  img.addEventListener('error', () => img.remove());
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
