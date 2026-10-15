import type { Knex } from 'knex';

/** Email one-time-code MFA: a second factor type, plus short-lived login/enrolment codes in verification_tokens. */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE mfa_factors DROP CONSTRAINT ck_mfa_factors_type;
    ALTER TABLE mfa_factors ADD CONSTRAINT ck_mfa_factors_type CHECK (type IN ('totp','email_otp'));
    ALTER TABLE verification_tokens DROP CONSTRAINT ck_verification_tokens_purpose;
    ALTER TABLE verification_tokens ADD CONSTRAINT ck_verification_tokens_purpose
      CHECK (purpose IN ('email_verify','password_reset','mfa_email_login','mfa_email_enrol'));
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DELETE FROM verification_tokens WHERE purpose IN ('mfa_email_login','mfa_email_enrol');
    DELETE FROM mfa_factors WHERE type = 'email_otp';
    ALTER TABLE verification_tokens DROP CONSTRAINT ck_verification_tokens_purpose;
    ALTER TABLE verification_tokens ADD CONSTRAINT ck_verification_tokens_purpose CHECK (purpose IN ('email_verify','password_reset'));
    ALTER TABLE mfa_factors DROP CONSTRAINT ck_mfa_factors_type;
    ALTER TABLE mfa_factors ADD CONSTRAINT ck_mfa_factors_type CHECK (type IN ('totp'));
  `);
}
