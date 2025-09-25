// Optional Auth0 middleware: enables JWT validation while supporting local bypass.
const { auth } = require("express-oauth2-jwt-bearer");
const config = require("../config");

/**
 * optionalAuth0
 * Returns an Express middleware function. When AUTH_DISABLED=true it injects a deterministic
 * dev identity (req.auth/req.user) so downstream code sees a valid principal without JWTs.
 * Otherwise configures express-oauth2-jwt-bearer to validate RS256 tokens against Auth0 issuer.
 * NOTE: For production AUTH_DISABLED must be false to enforce security.
 */
function optionalAuth0() {
  // Return middleware instance based on env flags.
  if (config.authDisabled) {
    return (req, res, next) => {
      // Dev bypass: attach a fake user for local runs
      req.auth = { sub: "dev|user", scope: "read:all write:all" };
      req.user = { sub: "dev|user" };
      next();
    };
  }
  return auth({
    // Express OAuth2 helper validates incoming tokens.
    audience: config.auth0.audience,
    issuerBaseURL: config.auth0.issuerBaseURL,
    tokenSigningAlg: "RS256",
  });
}

module.exports = { optionalAuth0 };
