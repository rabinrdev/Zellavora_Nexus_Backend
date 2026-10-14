/**
 * Verifies the configured SMTP provider. Without arguments it only connects and authenticates (no mail is sent).
 *   npm run smtp:check                       # connect + authenticate
 *   npm run smtp:check -- --to you@example   # also send one test message
 */
import 'dotenv/config';
import nodemailer from 'nodemailer';

const url = process.env.SMTP_URL;
if (!url) {
  console.error('SMTP_URL is not set');
  process.exit(2);
}
const to = process.argv.includes('--to') ? process.argv[process.argv.indexOf('--to') + 1] : undefined;
const u = new URL(url);
console.log(`SMTP host=${u.hostname} port=${u.port || '(default)'} secure=${u.protocol === 'smtps:'} user=${decodeURIComponent(u.username)}`);

const transport = nodemailer.createTransport(url);
try {
  await transport.verify();
  console.log('OK: connected and authenticated');
  if (to) {
    const info = await transport.sendMail({
      from: process.env.MAIL_FROM ?? 'Zellavora Nexus <no-reply@example.test>',
      to,
      subject: 'Zellavora Nexus SMTP test',
      text: 'This is a test message from the Zellavora Nexus API SMTP check.',
    });
    console.log(`OK: test message accepted (${info.messageId})`);
  }
} catch (e) {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exitCode = 1;
}
