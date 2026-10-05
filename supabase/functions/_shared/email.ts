// Email through the school's own account (Gmail with an app password, or any SMTP server on
// port 465/2525). Supabase blocks ports 25 and 587, so Microsoft 365 / Outlook can't be used.
import nodemailer from 'npm:nodemailer@6.9.16';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { emailError, isFatalEmailError, textToHtml } from './email_format.ts';

export type EmailAccount = {
  provider: 'gmail' | 'smtp';
  from_email: string;
  from_name: string;
  host: string;
  port: number;
  user: string;
  password: string;
};

export type Email = { to: string; toName?: string; subject: string; text: string; replyTo?: string | null };

/** The school's account, or null when none is set up. */
export async function loadEmailAccount(db: SupabaseClient, schoolId: string): Promise<EmailAccount | null> {
  const { data, error } = await db.rpc('email_account', { p_school: schoolId });
  if (error) throw new Error(error.message);
  return (data as EmailAccount | null) ?? null;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

/**
 * Sends the emails one after another over a single connection.
 * Returns 'sent' or 'error: …' for each email, in order.
 */
export async function sendEmails(account: EmailAccount, emails: Email[]): Promise<string[]> {
  const transport = nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure: account.port === 465,
    requireTLS: account.port !== 465,
    pool: true,
    maxConnections: 1,
    auth: { user: account.user, pass: account.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  const results: string[] = [];
  let fatal: string | null = null;
  try {
    for (const email of emails) {
      if (fatal) {
        results.push(`error: ${fatal}`);
        continue;
      }
      try {
        await transport.sendMail({
          from: { name: oneLine(account.from_name), address: account.from_email },
          to: email.toName ? { name: oneLine(email.toName), address: email.to } : email.to,
          replyTo: email.replyTo || undefined,
          subject: oneLine(email.subject),
          text: email.text,
          html: textToHtml(email.text),
        });
        results.push('sent');
      } catch (err) {
        const message = emailError(err);
        results.push(`error: ${message}`);
        if (isFatalEmailError(err)) fatal = message;
      }
    }
  } finally {
    transport.close();
  }
  return results;
}
