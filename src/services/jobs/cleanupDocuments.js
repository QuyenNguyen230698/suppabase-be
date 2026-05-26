import { query } from '../../db/index.js';

export default {
  name: 'cleanup_documents',
  description: 'Delete documents past their expires_at.',
  intervalMs: 6 * 60 * 60 * 1000, // 6h
  runAtBoot: true,
  async run() {
    const { rows } = await query(
      `DELETE FROM documents WHERE expires_at < NOW() RETURNING id, name`
    );
    if (rows.length) {
      console.log(`[jobs.cleanup] removed ${rows.length} expired docs`);
    }
  },
};
