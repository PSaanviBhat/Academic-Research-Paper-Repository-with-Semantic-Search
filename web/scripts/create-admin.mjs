// Create (or reset) the admin account from ADMIN_NAME / ADMIN_EMAIL /
// ADMIN_PASSWORD in the root .env file. Safe to run more than once.
//   npm --prefix web run seed:admin
// Admins cannot be created through the API: registration always makes a
// 'researcher', so this script is the only way to get an admin.
import path from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";
import bcrypt from "bcryptjs";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
nextEnv.loadEnvConfig(root);

const { ADMIN_NAME = "Admin", ADMIN_EMAIL, ADMIN_PASSWORD, DATABASE_URL } = process.env;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 8 characters) in .env");
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
// Upsert: create the admin, or promote/reset the existing account with that email.
const { rows } = await client.query(
  `INSERT INTO users (name, email, password_hash, role) VALUES ($1, lower($2), $3, 'admin')
   ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, role = 'admin'
   RETURNING user_id, email, role`,
  [ADMIN_NAME, ADMIN_EMAIL, hash],
);
console.log(`Admin ready: user_id=${rows[0].user_id} email=${rows[0].email} role=${rows[0].role}`);
await client.end();
