// Script: reset-usage.js
// Purpose: Manually reset a user's annual usage counters (admin utility)
// Usage: node scripts/reset-usage.js <auth0_sub_or_user_id>
// If UUID matches users.id it will use that; otherwise treats as auth0_sub.

const { query, poolPromise } = require("../src/db");
const { v4: uuidv4 } = require("uuid");

async function main() {
  const ident = process.argv[2];
  if (!ident) {
    console.error("Usage: node scripts/reset-usage.js <auth0_sub_or_user_id>");
    process.exit(1);
  }
  let user;
  if (/^[0-9a-fA-F-]{36}$/.test(ident)) {
    const r = await query("SELECT id, auth0_sub FROM users WHERE id = $1", [
      ident,
    ]);
    user = r.rows[0];
  } else {
    const r = await query(
      "SELECT id, auth0_sub FROM users WHERE auth0_sub = $1",
      [ident]
    );
    user = r.rows[0];
  }
  if (!user) {
    console.error("User not found");
    process.exit(2);
  }
  await query(
    `UPDATE users
       SET annual_usage_count = 0,
           annual_period_start = SYSUTCDATETIME(),
           updated_at = SYSUTCDATETIME()
     WHERE id = $1`,
    [user.id]
  );
  console.log(`Reset usage for user ${user.id}`);
  (await poolPromise).close();
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
