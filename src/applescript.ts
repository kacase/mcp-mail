import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function parseMailboxUrl(url: string): { accountId: string; mailboxName: string } | null {
  const match = url.match(/^[a-z]+:\/\/([^\/]+)\/(.+)$/i);
  if (!match) return null;
  return { accountId: match[1], mailboxName: decodeURIComponent(match[2]) };
}

export interface SendMessageOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
}

export async function sendMessage(opts: SendMessageOptions): Promise<void> {
  const subject = escapeAppleScript(opts.subject);
  const body = escapeAppleScript(opts.body);

  const toRecipients = opts.to
    .map(addr => `make new to recipient with properties {address:"${escapeAppleScript(addr)}"}`)
    .join('\n        ');

  const ccRecipients = (opts.cc ?? [])
    .map(addr => `make new cc recipient with properties {address:"${escapeAppleScript(addr)}"}`)
    .join('\n        ');

  const bccRecipients = (opts.bcc ?? [])
    .map(addr => `make new bcc recipient with properties {address:"${escapeAppleScript(addr)}"}`)
    .join('\n        ');

  const script = `
tell application "Mail"
  set msg to make new outgoing message with properties {subject:"${subject}", content:"${body}", visible:false}
  tell msg
    ${toRecipients}
    ${ccRecipients}
    ${bccRecipients}
  end tell
  send msg
end tell
`;

  await execFileAsync('osascript', ['-e', script]);
}

export interface ReplyOptions {
  messageId: number;
  mailboxUrl: string;
  body: string;
  replyAll?: boolean;
}

export async function replyToMessage(opts: ReplyOptions): Promise<void> {
  const parsed = parseMailboxUrl(opts.mailboxUrl);
  if (!parsed) throw new Error(`Invalid mailbox URL: ${opts.mailboxUrl}`);

  const { accountId, mailboxName } = parsed;
  const body = escapeAppleScript(opts.body);
  const replyAll = opts.replyAll ? 'true' : 'false';

  const script = `
tell application "Mail"
  set theAccount to account id "${accountId}"
  set theMailbox to mailbox "${escapeAppleScript(mailboxName)}" of theAccount
  set theMessages to (every message of theMailbox whose id is ${opts.messageId})
  if (count of theMessages) > 0 then
    set theMessage to item 1 of theMessages
    set theReply to reply theMessage reply to all ${replyAll}
    tell theReply
      set content to "${body}"
    end tell
    send theReply
  else
    error "Message not found"
  end if
end tell
`;

  await execFileAsync('osascript', ['-e', script]);
}

// mailboxUrl format: ews://UUID/MailboxName or imap://UUID/MailboxName
export async function getMessageBody(
  messageId: number,
  mailboxUrl: string
): Promise<{ text: string | null; html: string | null }> {
  const parsed = parseMailboxUrl(mailboxUrl);
  if (!parsed) return { text: null, html: null };

  const { accountId, mailboxName } = parsed;

  const script = `
tell application "Mail"
  set theAccount to account id "${accountId}"
  set theMailbox to mailbox "${escapeAppleScript(mailboxName)}" of theAccount
  set theMessages to (every message of theMailbox whose id is ${messageId})
  if (count of theMessages) > 0 then
    return content of (item 1 of theMessages)
  else
    return ""
  end if
end tell
`;
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script]);
    const text = stdout.trim();
    return { text: text || null, html: null };
  } catch {
    return { text: null, html: null };
  }
}
