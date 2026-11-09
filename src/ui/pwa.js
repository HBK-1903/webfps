// PWA glue: registers the service worker and exposes the install prompt.
//
// Kept separate from the game so that a browser without service-worker support
// simply plays the plain page, and so the headless tests can drive the install
// flow without side effects.
//
// Registering only makes sense over http(s); on a plain file:// page (the
// offline single-file build) there is no origin to install from, so we skip it
// and the game works exactly as before.

const hasWindow = typeof window !== 'undefined';
const isHttp = hasWindow && (location.protocol === 'http:' || location.protocol === 'https:');

/** Chrome's install prompt, kept until we decide to show it. */
let deferredPrompt = null;
const readyListeners = new Set();

function emitReady() {
  for (const fn of readyListeners) {
    try {
      fn(canInstall());
    } catch {
      /* a broken listener must not break the game */
    }
  }
}

// Captured at module load, *not* when the service worker registers: the event
// can fire on the very first load, and a browser without service workers may
// still be able to install. (This was a real bug: the prompt was lost.)
if (hasWindow) {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Chrome shows its own mini-infobar unless we take over; we want the
    // in-game menu button instead, so keep the event for later.
    event.preventDefault();
    deferredPrompt = event;
    emitReady();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    emitReady();
  });
}

export function registerServiceWorker({ onReady } = {}) {
  if (!hasWindow) return null;
  if (!isHttp || !('serviceWorker' in navigator)) return null;
  if (typeof onReady === 'function') onReady(canInstall());

  // Resolved against the *document*, not this module. With `import.meta.url`
  // the path in development became /src/ui/sw.js (this file's directory) rather
  // than /sw.js, so registration 404'd in the dev server. The built site worked
  // only because it bundles everything next to sw.js, which is exactly the kind
  // of difference between dev and production that hides bugs.
  const swUrl = new URL('sw.js', document.baseURI);
  // Scope must be the directory the game lives in, not the worker's own folder.
  // With /src/ui/sw.js the browser would scope it to /src/ui/ and the worker
  // would never control the game page at all. `/` is rejected when the worker
  // sits in a subdirectory, so fall back to the document directory.
  const scope = new URL('./', document.baseURI);
  return navigator.serviceWorker.register(swUrl, { scope }).catch(() => null);
}

/** True when the browser has offered an install prompt we can fire later. */
function canInstall() {
  return deferredPrompt !== null;
}

/** True when we are already running as an installed app. */
function isStandalone() {
  if (!hasWindow) return false;
  return (
    window.matchMedia?.('(display-mode: fullscreen)')?.matches === true ||
    window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
    navigator.standalone === true
  );
}

/** Fires the browser's install dialog. Resolves to true if the user accepted. */
async function promptInstall() {
  if (!deferredPrompt) return false;
  const event = deferredPrompt;
  deferredPrompt = null;
  try {
    event.prompt();
    const { outcome } = await event.userChoice;
    return outcome === 'accepted';
  } catch {
    return false;
  }
}

/**
 * Wires an "install as app" button to the browser's install prompt.
 *
 * The button is shown only when the browser has actually offered a prompt —
 * a permanently visible button that does nothing is worse than no button.
 * Returns a function that detaches the listeners (used by the tests).
 */
export function createInstallControls({ button, hint, notify } = {}) {
  const sync = () => {
    if (!button) return;
    const available = canInstall();
    button.hidden = !available;
    if (hint) {
      // Outside an installed app, also mention the browser-menu route, since
      // some browsers never fire the prompt event at all.
      hint.hidden = !(available || !isStandalone());
    }
  };

  const onClick = async () => {
    const accepted = await promptInstall();
    sync();
    if (typeof notify === 'function') {
      notify(accepted ? 'Uygulama kuruldu. Başlat menüsünden açabilirsin.' : 'Kurulum iptal edildi.');
    }
    return accepted;
  };

  readyListeners.add(sync);
  if (button) button.addEventListener('click', onClick);
  sync();

  return function detach() {
    readyListeners.delete(sync);
    if (button) button.removeEventListener('click', onClick);
  };
}

export { isHttp as pwaSupported };
