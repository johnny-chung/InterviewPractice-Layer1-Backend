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
    "SELECT id, auth0_sub, annual_limit, annual_usage_count, annual_period_start FROM users WHERE auth0_sub = $1",
    [auth0Sub]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const userId = uuidv4();
  await query(
    "INSERT INTO users (id, auth0_sub, email, annual_limit, annual_usage_count, annual_period_start) VALUES ($1, $2, $3, DEFAULT, DEFAULT, NULL)",
    [userId, auth0Sub, email || null]
  );

  return {
    id: userId,
    auth0_sub: auth0Sub,
    annual_limit: 100,
    annual_usage_count: 0,
    annual_period_start: null,
  };
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

/**
 * getUserWithUsage
 * Returns full usage-related fields for enforcement logic.
 */
async function getUserWithUsage(auth0Sub) {
  if (!auth0Sub) return null;
  const result = await query(
    "SELECT id, auth0_sub, annual_limit, annual_usage_count, annual_period_start FROM users WHERE auth0_sub = $1",
    [auth0Sub]
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * incrementAnnualUsage
 * Atomically increments usage count, resetting if more than 365 days have elapsed since annual_period_start (or if null).
 * Returns updated { annual_usage_count, annual_limit }.
 */
async function incrementAnnualUsage(userId) {
  // Fetch current values
  const current = await query(
    "SELECT annual_limit, annual_usage_count, annual_period_start FROM users WHERE id = $1",
    [userId]
  );
  if (current.rows.length === 0) throw new Error("user_not_found");
  let { annual_limit, annual_usage_count, annual_period_start } =
    current.rows[0];

  let reset = false;
  if (!annual_period_start) {
    reset = true;
  } else {
    const start = new Date(annual_period_start);
    const diffMs = Date.now() - start.getTime();
    if (diffMs > 365 * 24 * 60 * 60 * 1000) reset = true;
  }

  if (reset) annual_usage_count = 0;
  const newCount = annual_usage_count + 1;

  if (reset) {
    await query(
      `UPDATE users
         SET annual_usage_count = $1,
             annual_period_start = SYSUTCDATETIME(),
             updated_at = SYSUTCDATETIME()
       WHERE id = $2`,
      [newCount, userId]
    );
  } else {
    await query(
      `UPDATE users
         SET annual_usage_count = $1,
             updated_at = SYSUTCDATETIME()
       WHERE id = $2`,
      [newCount, userId]
    );
  }

  return { annual_limit, annual_usage_count: newCount };
}

module.exports = {
  ensureUser,
  getUserId,
  getUserWithUsage,
  incrementAnnualUsage,
};
