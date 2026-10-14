import type { Services } from './types.js';
import type { MailMessage } from './mail.js';
import { withPlatformScope } from './scope.js';

/** Registers queue workers and recurring schedules. Domain modules add their own via `jobRegistrars`. */
export const jobRegistrars: ((svc: Services) => void)[] = [];

export function registerJobs(svc: Services): void {
  svc.jobs.work('mail', async (data) => {
    await svc.mail.send(data as unknown as MailMessage);
  });

  // Housekeeping: expired idempotency keys, expired sessions' used refresh tokens, stale verification tokens.
  svc.jobs.work('retention', async () => {
    await withPlatformScope(svc.db, 'housekeeping', async (t) => {
      await t('idempotency_records').where('expires_at', '<', svc.now()).delete();
      await t('verification_tokens').where('expires_at', '<', new Date(svc.now().getTime() - 7 * 86400_000)).delete();
      await t('rate_limits').where('expire', '<', svc.now().getTime()).delete();
      await t('job_runs').where('started_at', '<', new Date(svc.now().getTime() - 90 * 86400_000)).delete();
      await t('used_refresh_tokens')
        .whereIn('session_id', t('sessions').select('id').where('absolute_expires_at', '<', svc.now()))
        .delete();
    });
  });

  for (const r of jobRegistrars) r(svc);
}
