import cleanupDocuments    from './cleanupDocuments.js';
import contractorLifecycle from './contractorLifecycle.js';
import conversationSummary from './conversationSummary.js';
import memoryExtract       from './memoryExtract.js';
import { registerJob, start } from '../queue/jobScheduler.js';

export function bootJobs() {
  registerJob(cleanupDocuments);
  registerJob(contractorLifecycle);
  registerJob(conversationSummary);
  registerJob(memoryExtract);
  return start();
}
