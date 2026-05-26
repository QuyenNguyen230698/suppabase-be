#!/usr/bin/env node
/**
 * Seed script: tạo user admin-suppabase với role super_admin
 * Chạy: node scripts/seed-admin.js
 */
import 'dotenv/config';
import bcrypt from 'bcrypt';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const USERNAME     = 'admin-suppabase';
const PASSWORD     = 'Quyen@2019';
const EMAIL        = 'admin@suppabase.local';
const FULL_NAME    = 'Super Administrator';
const ROOT_NODE_ID = '00000000-0000-0000-0000-000000000001'; // PEB Group (root)

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Hash password
    const password_hash = await bcrypt.hash(PASSWORD, 10);

    // 2. Insert user (idempotent)
    const { rows: [user] } = await client.query(
      `INSERT INTO users (username, email, password_hash, full_name, country_code, timezone, language, contract_type)
       VALUES ($1, $2, $3, $4, 'VN', 'Asia/Ho_Chi_Minh', 'vi', 'full_time')
       ON CONFLICT (username) DO UPDATE
         SET email         = EXCLUDED.email,
             full_name     = EXCLUDED.full_name,
             updated_at    = NOW()
       RETURNING id, username, email`,
      [USERNAME, EMAIL, password_hash, FULL_NAME]
    );
    console.log(`✓ User: ${user.username} (${user.id})`);

    // 3. Lấy role_id của super_admin
    const { rows: [role] } = await client.query(
      `SELECT id FROM roles WHERE name = 'super_admin'`
    );
    if (!role) throw new Error('Role super_admin không tìm thấy — hãy chạy migration 003_roles.sql trước');

    // 4. Assign super_admin tại root node (idempotent)
    await client.query(
      `INSERT INTO user_node_roles (user_id, node_id, role_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, node_id) DO UPDATE
         SET role_id    = EXCLUDED.role_id,
             granted_at = NOW()`,
      [user.id, ROOT_NODE_ID, role.id]
    );
    console.log(`✓ Role: super_admin tại node ${ROOT_NODE_ID} (PEB Group root)`);

    await client.query('COMMIT');
    console.log('\n✅ Seed thành công!');
    console.log(`   Username : ${USERNAME}`);
    console.log(`   Password : ${PASSWORD}`);
    console.log(`   Role     : super_admin`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed thất bại:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
