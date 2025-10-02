const express = require("express");
const { ensureUser } = require("../services/user-service");
const { query } = require("../db");
const { getAuthContext } = require("../utils/request-context");

const router = express.Router();

// GET /api/v1/usage -> { annual_limit, annual_usage_count, annual_period_start, remaining }
router.get("/", async (req, res, next) => {
  try {
    const auth = getAuthContext(req);
    if (!auth) return res.status(401).json({ error: "unauthorized" });
    const user = await ensureUser(auth.sub, auth.email);
    const result = await query(
      "SELECT annual_limit, annual_usage_count, annual_period_start FROM users WHERE id = $1",
      [user.id]
    );
    const row = result.rows[0];
    const remaining = Math.max(row.annual_limit - row.annual_usage_count, 0);
    res.json({ ...row, remaining });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
