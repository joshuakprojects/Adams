// Who is doing the current action (an office user's name, a driver, "Website"), for the job history.
// The server sets it once per request; code deep inside dispatch reads it without passing it around.
const { AsyncLocalStorage } = require('node:async_hooks');

const store = new AsyncLocalStorage();

/** Run fn with `actor` as the current actor. */
function runAs(actor, fn) {
  return store.run({ actor }, fn);
}

function currentActor(fallback = 'Office') {
  return store.getStore()?.actor || fallback;
}

module.exports = { runAs, currentActor };
