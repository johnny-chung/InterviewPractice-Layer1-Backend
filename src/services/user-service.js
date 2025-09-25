// User service: wraps user lookup/upsert logic used across controllers.
// Tables touched:
//   users -> (id UUID PK, auth0_sub unique, email) simple identity mapping for external provider subjects.
// Design notes:
//   - ensureUser is idempotent: repeated calls for same auth0_sub avoid duplicate rows.
//   - getUserId is a lightweight lookup that intentionally does NOT create a user (used for read-only contexts).
const { v4: uuidv4 } = require("uuid");
const { query } = require("../db");

/**
 * ensureUser
 * SELECT existing users row by auth0_sub; INSERT new row when absent.
 * Returns minimal identifying shape for downstream ownership checks.
 */
async function ensureUser(auth0Sub, email) {
  if (!auth0Sub) throw new Error("auth0Sub is required");
  const existing = await query(
    "SELECT id, auth0_sub FROM users WHERE auth0_sub = $1",
    [auth0Sub]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const userId = uuidv4();
  await query("INSERT INTO users (id, auth0_sub, email) VALUES ($1, $2, $3)", [
    userId,
    auth0Sub,
    email || null,
  ]);

  return { id: userId, auth0_sub: auth0Sub };
}

/**
 * getUserId
 * Lightweight SELECT returning only id; avoids upsert behavior for cases where absence is acceptable.
 */
async function getUserId(auth0Sub) {
  if (!auth0Sub) return null;
  const result = await query("SELECT id FROM users WHERE auth0_sub = $1", [
    auth0Sub,
  ]);
  return result.rows.length > 0 ? result.rows[0].id : null;
}

module.exports = {
  ensureUser,
  getUserId,
};
