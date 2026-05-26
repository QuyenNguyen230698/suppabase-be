import app from './app.js';
import { migrate, closePool } from './db/index.js';
import { bootJobs } from './services/jobs/index.js';
import { resumePending } from './services/usageReconciler.js';
import { migrateFromEnv as migrateProviderEnv } from './services/providerRouter.js';

const PORT = parseInt(process.env.PORT || '3000');

async function main() {
  try {
    await migrate();
    await migrateProviderEnv().catch((e) => console.warn('[server] provider env migration failed:', e.message));
    await bootJobs();
    resumePending().catch((e) => console.warn('[server] resumePending failed:', e.message));

    const server = app.listen(PORT, () => {
      console.log(`[Server] Ready on http://localhost:${PORT}`);
    });

    async function gracefulShutdown(signal) {
      server.close(async () => {
        await closePool();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000);
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  } catch (err) {
    console.error('[Server] Startup failed:', err.message);
    process.exit(1);
  }
}

main();
