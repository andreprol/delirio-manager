'use strict';

// Fase 4 (cutover pra Postgres): Express 4 não encaminha rejeição de
// promise de handler/middleware async pro error handler global (app.js) --
// sem isso, um `await` que rejeita vira unhandled rejection silenciosa,
// requisição nunca responde. Envolve toda rota/middleware async com isso.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
