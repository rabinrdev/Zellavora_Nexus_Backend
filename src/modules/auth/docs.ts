import { documentRoutes } from '../../platform/openapi/document.js';

documentRoutes({
  registerAccount: {
    description: 'Creates an individual or organization account and emails a verification token. The response is always `202` with the same message, whether or not the email already exists (no account enumeration). Rate limited per IP and per email.',
    requestExamples: {
      organization: { kind: 'organization', name: 'Amelia Hart', email: 'amelia.hart@example.test', password: 'Correct-Horse-Battery-9', organizationName: 'Acme Design Studio' },
      individual: { kind: 'individual', name: 'Amelia Hart', email: 'amelia.hart@example.test', password: 'Correct-Horse-Battery-9' },
    },
  },
  verifyEmailAddress: { description: 'Confirms the email with the token from the verification mail. Required before the first sign-in.' },
  resendEmailVerification: { description: 'Sends a fresh verification mail. Always `202` (no enumeration).' },
  loginWithPassword: {
    errors: [401],
    description: 'Signs in and returns the token bundle. Failed attempts increase a lockout (see the security policy). `401 UNAUTHENTICATED` is returned for wrong credentials, unverified or locked accounts and when MFA is required but `mfaCode` is missing (`details[0] = { field: "mfaCode", issue: "mfa_required" }`). A user in several organizations passes `organizationCode`; otherwise the last/only one is used.',
    requestExamples: { password: { email: 'amelia.hart@example.test', password: 'Correct-Horse-Battery-9' }, withMfa: { email: 'amelia.hart@example.test', password: 'Correct-Horse-Battery-9', mfaCode: '123456' } },
  },
  refreshAccessToken: { errors: [401], description: 'Exchanges the refresh token for a new access token **and a new refresh token** (rotation). Re-using an already rotated token revokes the whole session family (`401`).' },
  logoutCurrentSession: { description: 'Revokes the current session; its tokens stop working immediately.' },
  logoutAllSessions: { description: 'Revokes every session of the user on all devices.' },
  requestPasswordReset: { description: 'Mails a reset token if the account exists. Always `202`.' },
  resetPassword: { description: 'Sets a new password with the emailed token; all sessions are revoked. The password must satisfy the organization password policy (`422`).' },
  acceptInvitation: {
    errors: [401],
    description: 'Joins an organization with the invitation token. New people send `name` and `password`; existing users send their bearer token instead. Invalid or expired tokens return `401`.',
  },
  switchOrganization: { errors: [404], description: 'Makes another organization (of which the user is an active member) the active one and returns a new token bundle. Not a member → `404`.' },
  getCurrentUser: { description: 'The signed-in user, their organizations and the permission keys in the active organization. Call it right after login to bootstrap the UI. Works while MFA enrolment is pending.' },
  listMySessions: { description: 'Active sessions of the user; `current` marks the one making the request.' },
  revokeMySession: { description: 'Revokes one of the caller\'s own sessions; unknown ids return `404`.' },
  beginMfaEnrolment: { errors: [409], description: 'Generates a TOTP secret and `otpauth://` URL (show as QR code). The factor is not active until `confirmMfaEnrolment`.' },
  confirmMfaEnrolment: { description: 'Confirms the first TOTP code, activates MFA and returns one-time **recovery codes**. Store them now; they are never shown again.' },
  verifyMfaCode: { description: 'Completes MFA for a session that must verify; returns `{ verified }`.' },
  disableMfa: { description: 'Turns MFA off after re-entering the password and a current code.' },
  regenerateMfaRecoveryCodes: { description: 'Invalidates the previous recovery codes and returns a new set (shown once).' },
});
