// Progressive enhancement only: every page also works without JavaScript.

// The theme link must switch to the opposite of what is actually shown. Without a
// saved choice the server can't know the system theme, so fix the link here.
const themeLink = document.querySelector('a[href^="/theme/"]');
if (themeLink) {
  const shown = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const target = `/theme/${shown === 'dark' ? 'light' : 'dark'}`;
  themeLink.setAttribute('href', themeLink.getAttribute('href').replace(/^\/theme\/(light|dark)/, target));
}

// Live elapsed-time clocks on running timers (the server still measures the real time).
const clocks = document.querySelectorAll('[data-since]');
if (clocks.length) {
  const tick = () => {
    for (const clock of clocks) {
      const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(clock.dataset.since)) / 1000));
      clock.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
  };
  tick();
  setInterval(tick, 1000);
}

// Disable a form's submit button once it is sent, against double taps on slow Wi-Fi.
document.addEventListener('submit', (event) => {
  const button = event.target.querySelector('button[type="submit"]');
  if (button) setTimeout(() => (button.disabled = true), 0);
});

// Re-enable buttons when a page is restored from the back/forward cache.
window.addEventListener('pageshow', () => {
  for (const button of document.querySelectorAll('button[disabled]')) button.disabled = false;
});

// Open the settings panel that a #link (e.g. after saving a value) points into.
if (location.hash) {
  const target = document.getElementById(location.hash.slice(1));
  const panel = target?.closest('details');
  if (panel) {
    panel.open = true;
    target.scrollIntoView({ block: 'center' });
  }
}
