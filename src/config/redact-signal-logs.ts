// libsignal (under Baileys) prints whole SessionEntry objects with
// console.info/warn: "Closing session:", "Opening session:", "Removing old
// closed session:", "Session already closed". Each one carries privKey,
// rootKey and chain keys, so every reconnect wrote the session's private
// encryption keys into the Railway logs in plain text (found 2026-10-02).
//
// Keep the message, drop every object argument after it. Must be imported
// right after load-env, before Baileys is loaded.

const SIGNAL_MESSAGE = /session/i;

type ConsoleMethod = (...args: unknown[]) => void;

function redact(original: ConsoleMethod): ConsoleMethod {
  return (...args: unknown[]) => {
    const [first, ...rest] = args;
    if (typeof first === 'string' && SIGNAL_MESSAGE.test(first) && rest.some(a => a !== null && typeof a === 'object')) {
      original(first, '[keys redacted]');
      return;
    }
    original(...args);
  };
}

/* eslint-disable no-console */
console.info = redact(console.info.bind(console));
console.warn = redact(console.warn.bind(console));
console.log = redact(console.log.bind(console));
/* eslint-enable no-console */

export {};
