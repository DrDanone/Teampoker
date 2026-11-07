// Zeigt das vom Superadmin hochgeladene Logo oben links an (statt der Purple-Kurve).

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
