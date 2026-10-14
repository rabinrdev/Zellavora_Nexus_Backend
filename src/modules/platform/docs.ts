import { z } from 'zod';
import { documentRoutes, uuid, isoDate } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const adminOnly = 'Platform administrators only.';
const id = z.object({ id: uuid.describe('Identifier of the created record.') });

documentRoutes({
  listPlatformReleases: {
    response: rowOf('release_records'), responseName: 'PlatformRelease',
    list: { sortable: ['released_at'], filterable: [], defaultSort: '-released_at', searchable: false },
    description: `${adminOnly} Release history.`,
  },
  createPlatformRelease: {
    successStatus: 201,
    response: z.object({ id: uuid.describe('Release id.'), version: z.string().describe('Version.'), gitSha: z.string().optional().describe('Commit.'), notes: z.string().optional().describe('Release notes.') }),
    description: `${adminOnly} Records a release.`,
  },
  recordPlatformDeployment: {
    successStatus: 201,
    response: z.object({
      id: uuid.describe('Deployment id.'), version: z.string().describe('Version deployed.'), environment: z.enum(['staging', 'production']).describe('Target environment.'),
      status: z.enum(['started', 'succeeded', 'failed', 'rolled_back']).describe('Outcome.'), notes: z.string().optional().describe('Notes.'),
    }),
    description: `${adminOnly} Records a deployment.`,
  },
  listPlatformDeployments: {
    response: rowOf('deployment_records'), responseName: 'PlatformDeployment',
    list: { sortable: ['deployed_at'], filterable: [], defaultSort: '-deployed_at', searchable: false },
    description: `${adminOnly} Deployment history.`,
  },
  createPlatformIncident: {
    successStatus: 201,
    response: z.object({
      id: uuid.describe('Incident id.'), status: z.literal('open').describe('Initial status.'), title: z.string().describe('Title.'),
      severity: z.enum(['sev1', 'sev2', 'sev3', 'sev4']).describe('Severity.'), summary: z.string().optional().describe('Summary.'),
    }),
    description: `${adminOnly} Opens an incident.`,
  },
  resolvePlatformIncident: {
    successStatus: 200, response: z.object({ id: uuid.describe('Incident id.'), status: z.literal('resolved').describe('New status.') }),
    description: `${adminOnly} Resolves an open incident; resolved or unknown incidents return \`404\`.`,
  },
  listPlatformIncidents: {
    response: rowOf('incident_records'), responseName: 'PlatformIncident',
    list: { sortable: ['created_at'], filterable: ['status'], defaultSort: '-created_at', searchable: false },
    description: `${adminOnly} Incidents.`,
  },
  listPlatformJobRuns: {
    response: rowOf('job_runs'), responseName: 'JobRun',
    list: { sortable: ['started_at'], filterable: ['status'], defaultSort: '-started_at', searchable: false },
    description: `${adminOnly} Background job runs; extra filter \`queue\`. \`meta.queues\` lists the queue names.`,
  },
  provisionTenant: {
    successStatus: 201,
    response: z.object({
      organizationId: uuid.describe('New organization.'), code: z.string().describe('Organization code.'),
      adminUserId: uuid.describe('First administrator.'), jobId: uuid.describe('Provisioning job record.'),
    }),
    errors: [409],
    requestExamples: { starterPlan: { name: 'Acme Design Studio', adminEmail: 'owner@example.test', adminName: 'Amelia Hart', planKey: 'starter' } },
    description: `${adminOnly} Creates an organization, its first administrator and a setup email in one transaction. \`Idempotency-Key\` is **required**: replaying the key returns the original result, and a failed attempt is visible in \`listProvisioningJobs\`.`,
  },
  getPlatformHealth: {
    response: z.object({
      organizationsByStatus: z.record(z.string(), z.number().int()).describe('Organization count per status.'),
      failedJobsLast24h: z.number().int().describe('Failed or dead-lettered jobs in the last 24 hours.'),
    }),
    description: `${adminOnly} Platform-wide health counters.`,
  },
  recordPlatformBackup: {
    successStatus: 201, response: id, description: `${adminOnly} Called by \`scripts/backup.sh\` to record a backup run.`,
  },
  listPlatformBackups: {
    response: z.object({
      lastSuccessfulAt: isoDate.nullable().describe('Finish time of the most recent successful backup.'),
      runs: z.array(rowOf('backup_runs')).describe('The 30 most recent backup runs.'),
    }),
    responseName: 'BackupHistory', description: `${adminOnly} A critical alert is raised automatically when no backup succeeded in 36 hours.`,
  },
  grantSupportAccess: {
    successStatus: 201,
    response: z.object({ id: uuid.describe('Grant id.'), expiresAt: isoDate.describe('When the grant ends.'), readOnly: z.literal(true).describe('Support sessions are always read-only.') }),
    description: 'Lets platform support open a **read-only** session in this organization for 1-72 hours (default 4). Every support request is recorded in the organization\'s security log. Revoke early with `revokeSupportAccess`.',
  },
  listSupportAccessGrants: { response: rowOf('support_access_grants'), responseName: 'SupportAccessGrant', collection: true, description: 'The 50 most recent grants.' },
  revokeSupportAccess: { successStatus: 204, description: 'Revokes the grant and terminates live support sessions immediately.' },
  startSupportSession: {
    successStatus: 201,
    response: z.object({ accessToken: z.string().describe('Read-only access token for the tenant.'), expiresAt: isoDate.describe('Session end (max 1 hour, never after the grant).'), readOnly: z.literal(true).describe('Always read-only.') }),
    description: `${adminOnly} Requires an active, unrevoked grant from the tenant (\`403\` otherwise). Both the platform and the tenant audit trails record the session.`,
  },
  getTenantHealth: {
    response: z.object({
      organizationId: uuid.describe('Organization.'), status: z.string().describe('Lifecycle status.'), plan: z.string().nullable().describe('Plan key.'),
      activeMembers: z.number().int().describe('Active members.'), storageBytes: z.number().int().describe('Storage used.'),
      failedJobsLast24h: z.number().int().describe('Failed jobs.'), lastLoginAt: isoDate.nullable().describe('Latest sign-in.'),
      subscriptionStatus: z.string().nullable().describe('Latest subscription status.'), failedWebhookDeliveries: z.number().int().describe('Failed/dead webhook deliveries.'),
    }),
    responseName: 'TenantHealth', description: `${adminOnly} Computes and stores a health snapshot for one organization.`,
  },
  getTenantConfigCheck: {
    response: z.object({
      ok: z.boolean().describe('`true` when every check passes.'),
      checks: z.array(z.object({ check: z.string().describe('Check name.'), ok: z.boolean().describe('Result.'), detail: z.string().optional().describe('Extra information.') })).describe('Individual checks.'),
    }),
    responseName: 'TenantConfigCheck', description: `${adminOnly} Verifies owner, administrator, status, storage row and time zone.`,
  },
  getTenantQuotas: {
    response: z.record(z.string(), z.unknown()).describe('Quota key → value, e.g. `{ "storage.quota_bytes": 1073741824 }`.'),
    description: `${adminOnly} Quotas stored for the tenant.`,
  },
  replaceTenantQuotas: {
    successStatus: 200, response: z.object({ storageBytes: z.number().int().describe('New storage quota in bytes.') }),
    description: `${adminOnly} Sets the storage quota.`,
  },
  replaceTenantPlan: {
    successStatus: 200, response: z.object({ organizationId: uuid.describe('Organization.'), planKey: z.string().describe('Assigned plan.') }),
    description: `${adminOnly} Assigns a plan; unknown plans or organizations return \`404\`.`,
  },
  traceRequestDiagnostics: {
    response: z.object({
      requestId: z.string().describe('The traced request id.'),
      audit: z.array(rowOf('audit_events', { only: ['occurred_at', 'organization_id', 'actor_id', 'action', 'resource_type', 'outcome'] })).describe('Audit events with this correlation id.'),
      security: z.array(rowOf('security_events', { only: ['occurred_at', 'organization_id', 'event', 'outcome'] })).describe('Security events with this correlation id.'),
    }),
    responseName: 'RequestTrace', description: `${adminOnly} Follows one \`requestId\` across the audit and security logs (max 100 each).`,
  },
  createPlatformAlert: {
    successStatus: 201, response: z.object({ id: uuid.describe('Alert id.'), status: z.literal('open').describe('Initial status.') }),
    description: `${adminOnly} Raises an operational alert.`,
  },
  listPlatformAlerts: {
    response: rowOf('operational_alerts'), responseName: 'PlatformAlert',
    list: { sortable: ['created_at'], filterable: ['status', 'severity'], defaultSort: '-created_at', searchable: false },
    description: `${adminOnly} Operational alerts.`,
  },
  acknowledgePlatformAlert: {
    successStatus: 200, response: z.object({ id: uuid.describe('Alert id.'), status: z.enum(['acknowledged', 'resolved']).describe('New status.') }),
    description: `${adminOnly} Acknowledges an alert that is not resolved yet.`,
  },
  resolvePlatformAlert: {
    successStatus: 200, response: z.object({ id: uuid.describe('Alert id.'), status: z.enum(['acknowledged', 'resolved']).describe('New status.') }),
    description: `${adminOnly} Resolves an alert.`,
  },
  listProvisioningJobs: {
    response: rowOf('tenant_provisioning_jobs'), responseName: 'ProvisioningJob',
    list: { sortable: ['created_at'], filterable: ['status'], defaultSort: '-created_at', searchable: false },
    description: `${adminOnly} Tenant provisioning attempts, including failures with the step list.`,
  },
  issueTenantFirstAdminLink: {
    successStatus: 200, response: z.object({ organizationId: uuid.describe('Organization.'), sentTo: z.string().email().describe('Address the setup link was mailed to.') }),
    errors: [409], description: `${adminOnly} Mails a 48-hour password-setup token to the owner. \`409\` when the owner already has a password.`,
  },
});
