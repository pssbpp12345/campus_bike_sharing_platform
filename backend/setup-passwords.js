// ──────────────────────────────────────────────────────────────
// setup-passwords.js
//
// Replaces the placeholder bcrypt hashes in the seed data with
// real hashes for "Password123!" so you can immediately log in
// as any of the demo users after running 04_seed.sql.
//
// Usage:
//   cd backend
//   npm install
//   cp .env.example .env       # then edit DB credentials
//   node setup-passwords.js
// ──────────────────────────────────────────────────────────────

require("dotenv").config();
const bcrypt = require("bcrypt");
const db = require("./db");

const DEMO_PASSWORD = "Password123!";
const ROUNDS = 12;

const DEMO_EMAILS = [
  "admin@university.edu",
  "janet.l@university.edu",
  "alice@university.edu",
  "bob@university.edu",
  "carol@university.edu",
  "david@university.edu",
];

(async () => {
  try {
    console.log(`Hashing demo password "${DEMO_PASSWORD}" (bcrypt rounds=${ROUNDS})…`);
    const hash = await bcrypt.hash(DEMO_PASSWORD, ROUNDS);

    console.log("Updating seeded users in the `users` table…");
    const result = await db.query(
      `UPDATE users
          SET password_hash = $1,
              updated_at    = NOW()
        WHERE email = ANY($2::text[])
        RETURNING id, email, role`,
      [hash, DEMO_EMAILS]
    );

    if (result.rowCount === 0) {
      console.warn("");
      console.warn("  No matching demo users were found.");
      console.warn("  Did you run database/04_seed.sql first?");
      console.warn("");
    } else {
      console.log("");
      console.log(`  Updated ${result.rowCount} demo user(s):`);
      for (const row of result.rows) {
        console.log(`    • ${row.email.padEnd(32)} (${row.role})`);
      }
      console.log("");
      console.log(`  All of them now share the password: ${DEMO_PASSWORD}`);
      console.log("");
    }
  } catch (err) {
    console.error("Failed to update demo passwords:", err.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
})();
