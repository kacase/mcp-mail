import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { simpleParser, ParsedMail } from 'mailparser';

const emlxCache = new Map<string, string>(); // "mailboxDir/rowid" -> filepath

function parseMailboxUrl(url: string): { uuid: string; mailboxName: string } | null {
  // URL format: ews://UUID/MailboxName or imap://UUID/MailboxName
  const match = url.match(/^[a-z]+:\/\/([^\/]+)\/(.+)$/i);
  if (!match) return null;
  return {
    uuid: match[1],
    mailboxName: decodeURIComponent(match[2]),
  };
}

function findEmlxInDir(dir: string, rowid: number): string | null {
  const target = `${rowid}.emlx`;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === target) {
        return join(current, entry);
      }
      const full = join(current, entry);
      // Only recurse into Data directories and numeric subdirs
      if (!entry.includes('.')) {
        stack.push(full);
      }
    }
  }
  return null;
}

export function findEmlxPath(mailRoot: string, mailboxUrl: string, rowid: number): string | null {
  const cacheKey = `${mailboxUrl}/${rowid}`;
  if (emlxCache.has(cacheKey)) {
    return emlxCache.get(cacheKey)!;
  }

  const parsed = parseMailboxUrl(mailboxUrl);
  if (!parsed) return null;

  const { uuid, mailboxName } = parsed;
  const mboxDir = join(mailRoot, uuid, `${mailboxName}.mbox`);

  if (!existsSync(mboxDir)) {
    // Try URL-encoded variants or different casings
    return null;
  }

  const dataDir = join(mboxDir, 'Data');
  const searchDir = existsSync(dataDir) ? dataDir : mboxDir;

  const found = findEmlxInDir(searchDir, rowid);
  if (found) {
    emlxCache.set(cacheKey, found);
  }
  return found;
}

export interface ParsedMessage {
  text: string | null;
  html: string | null;
  attachments: Array<{
    filename: string;
    contentType: string;
    size: number;
  }>;
  headers: Record<string, string>;
  from: string | null;
  to: string | null;
  subject: string | null;
  date: Date | null;
}

export async function parseEmlx(filePath: string): Promise<ParsedMessage> {
  const raw = readFileSync(filePath);

  // First line contains the byte count of the RFC 2822 message
  const newlineIdx = raw.indexOf(0x0a);
  if (newlineIdx === -1) {
    throw new Error('Invalid EMLX: no newline found');
  }

  const firstLine = raw.slice(0, newlineIdx).toString('ascii').trim();
  const byteCount = parseInt(firstLine, 10);
  if (isNaN(byteCount)) {
    throw new Error(`Invalid EMLX: bad byte count "${firstLine}"`);
  }

  const messageBuffer = raw.slice(newlineIdx + 1, newlineIdx + 1 + byteCount);
  const parsed: ParsedMail = await simpleParser(messageBuffer);

  const headers: Record<string, string> = {};
  for (const [key, value] of parsed.headers) {
    headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  return {
    text: parsed.text ?? null,
    html: parsed.html || null,
    attachments: (parsed.attachments ?? []).map(att => ({
      filename: att.filename ?? 'attachment',
      contentType: att.contentType,
      size: att.size ?? 0,
    })),
    headers,
    from: parsed.from?.text ?? null,
    to: parsed.to
      ? Array.isArray(parsed.to)
        ? parsed.to.map(a => a.text).join(', ')
        : parsed.to.text
      : null,
    subject: parsed.subject ?? null,
    date: parsed.date ?? null,
  };
}

export async function getAttachmentData(
  filePath: string,
  attachmentIndex: number
): Promise<{ data: Buffer; filename: string; contentType: string } | null> {
  const raw = readFileSync(filePath);
  const newlineIdx = raw.indexOf(0x0a);
  if (newlineIdx === -1) return null;

  const firstLine = raw.slice(0, newlineIdx).toString('ascii').trim();
  const byteCount = parseInt(firstLine, 10);
  if (isNaN(byteCount)) return null;

  const messageBuffer = raw.slice(newlineIdx + 1, newlineIdx + 1 + byteCount);
  const parsed: ParsedMail = await simpleParser(messageBuffer);

  const att = parsed.attachments?.[attachmentIndex];
  if (!att) return null;

  return {
    data: att.content,
    filename: att.filename ?? 'attachment',
    contentType: att.contentType,
  };
}
