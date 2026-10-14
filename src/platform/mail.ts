import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailProvider {
  send(msg: MailMessage): Promise<void>;
  ping(): Promise<boolean>;
}

/** Dev/test driver: keeps messages in memory so tests can read tokens out of them. */
export class MemoryMailProvider implements MailProvider {
  readonly outbox: MailMessage[] = [];
  async send(msg: MailMessage) {
    this.outbox.push(msg);
  }
  async ping() {
    return true;
  }
  last(to?: string): MailMessage | undefined {
    return [...this.outbox].reverse().find((m) => !to || m.to === to);
  }
}

export class SmtpMailProvider implements MailProvider {
  private readonly transport;
  constructor(url: string, private readonly from: string) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(msg: MailMessage) {
    await this.transport.sendMail({ from: this.from, ...msg });
  }
  async ping() {
    try {
      await this.transport.verify();
      return true;
    } catch {
      return false;
    }
  }
}
