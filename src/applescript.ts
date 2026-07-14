import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', heic: 'image/heic',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', tiff: 'image/tiff',
  txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html', xml: 'text/xml',
  json: 'application/json', ics: 'text/calendar', eml: 'message/rfc822', vcf: 'text/vcard',
  zip: 'application/zip', gz: 'application/gzip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
};

function mimeFromName(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return (m && MIME_BY_EXT[m[1]]) || 'application/octet-stream';
}

// Ask Apple Mail to download an attachment from the server (iCloud/IMAP/Exchange)
// and save it to a temp file, then read the bytes back. Used when the message isn't
// cached locally as an .emlx, so the attachment bytes aren't on disk yet.
// `index` is the 0-based position in the message's attachment list.
//
// NOTE: Mail's `MIME type` attachment property reliably throws -10000 ("AppleEvent
// handler failed") on current macOS, so we avoid it entirely and infer the content
// type from the filename. `save`, `name`, and `file size` all work fine.
export async function getAttachmentViaMail(
  messageId: number,
  mailboxUrl: string,
  index: number
): Promise<{ data: Buffer; filename: string; contentType: string } | null> {
  const parsed = parseMailboxUrl(mailboxUrl);
  if (!parsed) return null;

  const { accountId, mailboxName } = parsed;
  const item = index + 1; // AppleScript lists are 1-based

  const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-mail-att-'));
  const destPath = join(tmpDir, `att-${index}`);

  const script = `
tell application "Mail"
  set theMessages to (every message of mailbox "${escapeAppleScript(mailboxName)}" of account id "${accountId}" whose id is ${messageId})
  if (count of theMessages) is 0 then error "Message not found in Mail"
  set theMsg to item 1 of theMessages
  -- Touch the body to force a full fetch from the server if not cached locally
  try
    set _b to content of theMsg
  end try
  if (count of mail attachments of theMsg) < ${item} then error "Attachment index out of range (message has " & (count of mail attachments of theMsg) & " attachment(s))"
  set theAtt to mail attachment ${item} of theMsg
  set theName to "attachment-${index}"
  try
    set theName to name of theAtt
  end try
  save theAtt in (POSIX file "${escapeAppleScript(destPath)}")
  return theName
end tell
`;

  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const rawName = stdout.trim();
    const filename = rawName && rawName !== 'missing value' ? rawName : `attachment-${index}`;

    const data = readFileSync(destPath);
    if (data.length === 0) {
      throw new Error('Apple Mail saved an empty file — the attachment could not be fetched from the server');
    }
    return { data, filename, contentType: mimeFromName(filename) };
  } catch (err) {
    const msg = String(err).replace(/\s+/g, ' ').trim();
    throw new Error(`Apple Mail could not download attachment ${index} of message ${messageId}: ${msg}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
