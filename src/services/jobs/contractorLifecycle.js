import { query } from '../../db/index.js';

// Auto-disable contractor accounts older than N months past hire_date.
// Configurable via env CONTRACTOR_MAX_MONTHS (default 12).
const MAX_MONTHS = parseInt(process.env.CONTRACTOR_MAX_MONTHS || '12', 10);

export default {
  name: 'contractor_lifecycle',
  description: `Disable contractors with hire_date older than ${MAX_MONTHS} months.`,
  intervalMs: 24 * 60 * 60 * 1000, // daily
  runAtBoot: false,
  async run() {
    const { rows } = await query(
      `UPDATE users
          SET is_active = FALSE,
              updated_at = NOW(),
              permission_version = permission_version + 1
        WHERE contract_type = 'contractor'
          AND is_active = TRUE
          AND hire_date IS NOT NULL
          AND hire_date < NOW() - ($1::int || ' months')::interval
        RETURNING id, username`,
      [MAX_MONTHS]
    );
    if (rows.length) {
      console.log(`[jobs.contractor] disabled ${rows.length} expired contractors`);
    }
  },
};
