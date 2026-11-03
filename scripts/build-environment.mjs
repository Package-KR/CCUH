import { ensureEnvironmentCollector } from '../src/common/environment/build.ts';

try {
  const result = await ensureEnvironmentCollector({ timeoutMs: 30000, force: true });
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status !== 'ready') process.exitCode = 1;
} catch {
  process.stdout.write(JSON.stringify({ status: 'unavailable', reason: 'prepare-failed' }) + '\n');
  process.exitCode = 1;
}
