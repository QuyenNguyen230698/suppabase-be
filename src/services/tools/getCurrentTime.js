export const schema = {
  name: 'get_current_time',
  description: 'Get the current date and time. Use when the user asks about today, now, or any time-sensitive question.',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA timezone name (e.g. "Asia/Ho_Chi_Minh", "UTC"). Defaults to UTC.',
      },
    },
    required: [],
  },
};

export async function execute({ timezone }) {
  const tz = timezone || 'UTC';
  const now = new Date();
  let formatted;
  try {
    formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, dateStyle: 'full', timeStyle: 'long',
    }).format(now);
  } catch {
    formatted = now.toISOString();
  }
  return {
    iso: now.toISOString(),
    timezone: tz,
    formatted,
    unix_ms: now.getTime(),
  };
}
