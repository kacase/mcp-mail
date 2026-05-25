import Database from 'better-sqlite3';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface Mailbox {
  rowid: number;
  url: string;
  total_count: number;
  unread_count: number;
}

export interface MessageRow {
  id: number;
  subject: string;
  sender: string;
  sender_name: string | null;
  date_received: number;
  read: number;
  flags: number;
  size: number;
  document_id: string | null;
  snippet: string | null;
  mailbox_url: string;
  conversation_id: number | null;
}

export interface Attachment {
  rowid: number;
  message: number;
  attachment_id: string;
  name: string;
}

export interface Recipient {
  address: string;
  name: string | null;
  type: number; // 1=To, 2=Cc, 3=Bcc
}

function findMailDB(): string {
  const mailRoot = join(homedir(), 'Library', 'Mail');
  // Try known versions from highest to lowest, avoiding readdirSync on ~/Library/Mail
  for (const version of ['V10', 'V9', 'V8', 'V7', 'V6', 'V5']) {
    const dbPath = join(mailRoot, version, 'MailData', 'Envelope Index');
    if (existsSync(dbPath)) return dbPath;
  }
  throw new Error('Envelope Index not found in ~/Library/Mail/V*/MailData/');
}

export function getMailRoot(): string {
  const mailRoot = join(homedir(), 'Library', 'Mail');
  for (const version of ['V10', 'V9', 'V8', 'V7', 'V6', 'V5']) {
    const candidate = join(mailRoot, version);
    if (existsSync(join(candidate, 'MailData', 'Envelope Index'))) return candidate;
  }
  throw new Error('Mail root not found');
}

export class MailDB {
  private db: Database.Database;
  private hasFTS: boolean;
  private hasSummaries: boolean;

  constructor() {
    const dbPath = findMailDB();
    // Open in readonly mode (better-sqlite3 doesn't support URI mode flags directly)
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    this.hasFTS = this.checkFTS();
    this.hasSummaries = this.checkSummaries();
  }

  private checkFTS(): boolean {
    try {
      const result = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='searchable_messages'"
      ).get() as { name: string } | undefined;
      return result !== undefined;
    } catch {
      return false;
    }
  }

  private checkSummaries(): boolean {
    try {
      const result = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='summaries'"
      ).get() as { name: string } | undefined;
      return result !== undefined;
    } catch {
      return false;
    }
  }

  listMailboxes(): Mailbox[] {
    return this.db.prepare(`
      SELECT ROWID as rowid, url, total_count, unread_count
      FROM mailboxes
      ORDER BY url
    `).all() as Mailbox[];
  }

  listMessages(mailboxRowid: number, limit: number, offset: number): MessageRow[] {
    const summaryJoin = this.hasSummaries
      ? 'LEFT JOIN summaries sum ON sum.ROWID = msg.summary'
      : '';
    const summarySelect = this.hasSummaries ? 'sum.summary as snippet,' : 'NULL as snippet,';

    return this.db.prepare(`
      SELECT msg.ROWID as id, s.subject, a.address as sender, a.comment as sender_name,
             msg.date_received, msg.read, msg.flags, msg.size, msg.document_id,
             ${summarySelect}
             mb.url as mailbox_url,
             msg.conversation_id
      FROM messages msg
      JOIN subjects s ON s.ROWID = msg.subject
      JOIN addresses a ON a.ROWID = msg.sender
      JOIN mailboxes mb ON mb.ROWID = msg.mailbox
      ${summaryJoin}
      WHERE msg.mailbox = ? AND msg.deleted = 0
      ORDER BY msg.date_received DESC
      LIMIT ? OFFSET ?
    `).all(mailboxRowid, limit, offset) as MessageRow[];
  }

  getMessage(rowid: number): MessageRow | undefined {
    const summaryJoin = this.hasSummaries
      ? 'LEFT JOIN summaries sum ON sum.ROWID = msg.summary'
      : '';
    const summarySelect = this.hasSummaries ? 'sum.summary as snippet,' : 'NULL as snippet,';

    return this.db.prepare(`
      SELECT msg.ROWID as id, s.subject, a.address as sender, a.comment as sender_name,
             msg.date_received, msg.read, msg.flags, msg.size, msg.document_id,
             ${summarySelect}
             mb.url as mailbox_url,
             msg.conversation_id
      FROM messages msg
      JOIN subjects s ON s.ROWID = msg.subject
      JOIN addresses a ON a.ROWID = msg.sender
      JOIN mailboxes mb ON mb.ROWID = msg.mailbox
      ${summaryJoin}
      WHERE msg.ROWID = ?
    `).get(rowid) as MessageRow | undefined;
  }

  getThread(conversationId: number): MessageRow[] {
    const summaryJoin = this.hasSummaries
      ? 'LEFT JOIN summaries sum ON sum.ROWID = msg.summary'
      : '';
    const summarySelect = this.hasSummaries ? 'sum.summary as snippet,' : 'NULL as snippet,';

    return this.db.prepare(`
      SELECT msg.ROWID as id, s.subject, a.address as sender, a.comment as sender_name,
             msg.date_received, msg.read, msg.flags, msg.size, msg.document_id,
             ${summarySelect}
             mb.url as mailbox_url,
             msg.conversation_id
      FROM messages msg
      JOIN subjects s ON s.ROWID = msg.subject
      JOIN addresses a ON a.ROWID = msg.sender
      JOIN mailboxes mb ON mb.ROWID = msg.mailbox
      ${summaryJoin}
      WHERE msg.conversation_id = ? AND msg.deleted = 0
      ORDER BY msg.date_received ASC
    `).all(conversationId) as MessageRow[];
  }

  searchMessages(query: string, limit: number): MessageRow[] {
    const summaryJoin = this.hasSummaries
      ? 'LEFT JOIN summaries sum ON sum.ROWID = msg.summary'
      : '';
    const summarySelect = this.hasSummaries ? 'sum.summary as snippet,' : 'NULL as snippet,';

    if (this.hasFTS) {
      try {
        return this.db.prepare(`
          SELECT msg.ROWID as id, s.subject, a.address as sender, a.comment as sender_name,
                 msg.date_received, msg.read, msg.flags, msg.size, msg.document_id,
                 ${summarySelect}
                 mb.url as mailbox_url,
                 msg.conversation_id
          FROM searchable_messages sm
          JOIN messages msg ON msg.ROWID = sm.rowid
          JOIN subjects s ON s.ROWID = msg.subject
          JOIN addresses a ON a.ROWID = msg.sender
          JOIN mailboxes mb ON mb.ROWID = msg.mailbox
          ${summaryJoin}
          WHERE searchable_messages MATCH ? AND msg.deleted = 0
          LIMIT ?
        `).all(query, limit) as MessageRow[];
      } catch {
        // Fall through to LIKE search
      }
    }

    // Fallback: LIKE search on subjects
    const likeQuery = `%${query}%`;
    return this.db.prepare(`
      SELECT msg.ROWID as id, s.subject, a.address as sender, a.comment as sender_name,
             msg.date_received, msg.read, msg.flags, msg.size, msg.document_id,
             ${summarySelect}
             mb.url as mailbox_url,
             msg.conversation_id
      FROM messages msg
      JOIN subjects s ON s.ROWID = msg.subject
      JOIN addresses a ON a.ROWID = msg.sender
      JOIN mailboxes mb ON mb.ROWID = msg.mailbox
      ${summaryJoin}
      WHERE (s.subject LIKE ? OR a.address LIKE ?) AND msg.deleted = 0
      ORDER BY msg.date_received DESC
      LIMIT ?
    `).all(likeQuery, likeQuery, limit) as MessageRow[];
  }

  getRecipients(messageRowid: number): Recipient[] {
    return this.db.prepare(`
      SELECT a.address, a.comment as name, r.type
      FROM recipients r
      JOIN addresses a ON a.ROWID = r.address
      WHERE r.message = ?
    `).all(messageRowid) as Recipient[];
  }

  getAttachments(messageRowid: number): Attachment[] {
    return this.db.prepare(`
      SELECT ROWID as rowid, message, attachment_id, name
      FROM attachments
      WHERE message = ?
    `).all(messageRowid) as Attachment[];
  }

  getMailboxById(rowid: number): Mailbox | undefined {
    return this.db.prepare(`
      SELECT ROWID as rowid, url, total_count, unread_count
      FROM mailboxes WHERE ROWID = ?
    `).get(rowid) as Mailbox | undefined;
  }

  getMailboxByName(name: string): Mailbox | undefined {
    return this.db.prepare(`
      SELECT ROWID as rowid, url, total_count, unread_count
      FROM mailboxes
      WHERE url LIKE ?
      LIMIT 1
    `).get(`%/${name}`) as Mailbox | undefined;
  }

  close(): void {
    this.db.close();
  }
}
