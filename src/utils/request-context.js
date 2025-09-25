// Request context helper: normalises user identity across auth and dev bypass flows.\n
const config = require('../config');

function getAuthContext(req) {
  if (req.user && req.user.sub) {
    return { sub: req.user.sub, email: req.user.email || null };
  }
  if (req.auth && req.auth.payload && req.auth.payload.sub) {
    const payload = req.auth.payload;
    return { sub: payload.sub, email: payload.email || null };
  }
  if (config.authDisabled) {
    return { sub: 'dev|user', email: null };
  }
  return null;
}

module.exports = { getAuthContext };

