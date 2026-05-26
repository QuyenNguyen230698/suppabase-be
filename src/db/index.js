import pg from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

export const query = (text, params) => pool.query(text, params);

export async function migrate() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(__dirname, 'migrations');

  // Ensure tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Load already-applied set
  const { rows } = await pool.query('SELECT filename FROM _migrations');
  const applied = new Set(rows.map(r => r.filename));

  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;  // skip already applied

    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      console.log(`[DB] Migration applied: ${file}`);
    } catch (err) {
      console.error(`[DB] Migration ${file} failed:`, err.message || err.code || err);
      throw err;
    }
  }
}

export async function closePool() {
  await pool.end();
}

export default pool;
