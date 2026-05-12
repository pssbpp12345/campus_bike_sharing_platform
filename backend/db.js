// ──────────────────────────────────────────────────────────────
// db.js — single PostgreSQL connection pool used by every route.
// ──────────────────────────────────────────────────────────────

const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || "campus_bike_sharing",
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres",
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected error on idle client:", err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
