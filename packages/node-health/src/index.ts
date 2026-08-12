/**
 * @morphit/node-health — pure, process-agnostic node-health decisions.
 *
 * Shared by the `morphit-ops` health view (apps/ops-cli) and the public
 * /v1/health endpoint (apps/indexer) so the two can never drift.  Facts
 * gathering stays per-process; only the decisions live here.
 */

export {
	classifySeeding,
	type ServiceState,
	type SeedingState,
	type SeedingFacts,
	type SeedingProblem,
	type SeedingReason,
	type SeedingClassification
} from './seeding.js';

export {
	resolveHealthDiskPath,
	HEALTH_DISK_PATH_ENV,
	DEFAULT_HEALTH_DISK_PATH
} from './disk.js';
