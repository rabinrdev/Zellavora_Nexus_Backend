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
    description: 'Accepts plain credentials or the encrypted `AuthenticateUser` shape: call `getLoginToken` first, then send `userLoginId` (email) and `password` AES-256-CBC encrypted (base64, PKCS7) with `tokenkeys` = the `[key, iv]` array. A forged/expired `tokenkeys` or undecryptable field returns `422` (`invalid_or_expired`). `clientCode` is used as `organizationCode` when that is absent. Signs in and returns the token bundle. Failed attempts increase a lockout (see the security policy). `401 UNAUTHENTICATED` is returned for wrong credentials, unverified or locked accounts and when MFA is required but `mfaCode` is missing (`details[0] = { field: "mfaCode", issue: "mfa_required" }`). A user in several organizations passes `organizationCode`; otherwise the last/only one is used.',
    requestExamples: { encrypted: { userLoginId: 'U17tXqkiF0JMSzWMpNXPPg==', password: 'yHbUckhfMTLcSmJwgYQzMg==', tokenkeys: ['bXktMzItYnl0ZS1iYXNlNjQta2V5LWV4YW1wbGUtMTIzNDU=', 'AAAAAGl2LWV4YW1wbGUtMTI='], clientCode: 'DC' }, password: { email: 'amelia.hart@example.test', password: 'Correct-Horse-Battery-9' }, withMfa: { email: 'amelia.hart@example.test', password: 'Correct-Horse-Battery-9', mfaCode: '123456' } },
  },
  getLoginToken: {
    description: 'Step 1 of the encrypted sign-in. Returns the token as an array of two base64 strings: `[key, iv]` (AES-256 key, 16-byte IV), valid for 5 minutes. Stateless: the key is derived from the IV with a server secret and verified at login. Rate limited per IP.',
    responseExample: ['bXktMzItYnl0ZS1iYXNlNjQta2V5LWV4YW1wbGUtMTIzNDU=', 'AAAAAGl2LWV4YW1wbGUtMTI='],
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
