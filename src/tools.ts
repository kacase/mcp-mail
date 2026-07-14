import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { writeFileSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join } from 'path';
import { MailDB } from './db.js';
import { findEmlxPath, parseEmlx, getAttachmentData } from './emlx.js';
import { sendMessage, replyToMessage, getMessageBody, getAttachmentViaMail } from './applescript.js';

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function recipientTypeName(type: number): string {
  switch (type) {
    case 0: return 'to';
    case 1: return 'cc';
    case 2: return 'bcc';
    default: return 'unknown';
  }
}

export function registerTools(server: McpServer, db: MailDB, mailRoot: string): void {

  // Tool 1: list_mailboxes
  server.tool(
    'list_mailboxes',
    'List all mailboxes in Apple Mail with message counts',
    {},
    async () => {
      const mailboxes = db.listMailboxes();
      const result = mailboxes.map(mb => ({
        id: mb.rowid,
        url: mb.url,
        name: mb.url.split('/').pop() ?? mb.url,
        total_count: mb.total_count,
        unread_count: mb.unread_count,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool 2: list_messages
  server.tool(
    'list_messages',
    'List messages in a mailbox',
    {
      mailbox_id: z.number().describe('Mailbox ROWID from list_mailboxes'),
      limit: z.number().default(50).describe('Max messages to return'),
      offset: z.number().default(0).describe('Pagination offset'),
    },
    async ({ mailbox_id, limit, offset }) => {
      const messages = db.listMessages(mailbox_id, limit, offset);
      const result = messages.map(msg => ({
        id: msg.id,
        subject: msg.subject,
        sender: msg.sender,
        sender_name: msg.sender_name,
        date: formatDate(msg.date_received),
        read: msg.read === 1,
        size: msg.size,
        snippet: msg.snippet,
        conversation_id: msg.conversation_id,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool 3: get_message
  server.tool(
    'get_message',
    'Get full message content including body text and HTML',
    {
      message_id: z.number().describe('Message ROWID'),
      include_html: z.boolean().default(false).describe('Include HTML body if available'),
    },
    async ({ message_id, include_html }) => {
      const msg = db.getMessage(message_id);
      if (!msg) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Message not found' }) }],
        };
      }

      const recipients = db.getRecipients(message_id);
      const attachmentMeta = db.getAttachments(message_id);

      const result: Record<string, unknown> = {
        id: msg.id,
        subject: msg.subject,
        sender: msg.sender,
        sender_name: msg.sender_name,
        date: formatDate(msg.date_received),
        read: msg.read === 1,
        size: msg.size,
        conversation_id: msg.conversation_id,
        recipients: recipients.map(r => ({
          address: r.address,
          name: r.name,
          type: recipientTypeName(r.type),
        })),
        attachments: attachmentMeta.map((a, i) => ({
          index: i,
          id: a.rowid,
          name: a.name,
          attachment_id: a.attachment_id,
        })),
      };

      // Try to load EMLX body
      const emlxPath = findEmlxPath(mailRoot, msg.mailbox_url, message_id);
      if (emlxPath) {
        try {
          const parsed = await parseEmlx(emlxPath);
          result.body_text = parsed.text;
          if (include_html) {
            result.body_html = parsed.html;
          }
          if (parsed.attachments.length > 0) {
            result.attachments = parsed.attachments.map((a, i) => ({
              index: i,
              filename: a.filename,
              content_type: a.contentType,
              size: a.size,
            }));
          }
        } catch (err) {
          result.body_error = String(err);
        }
      } else {
        // EMLX not available locally (EWS/remote account) — fetch via AppleScript
        try {
          const body = await getMessageBody(message_id, msg.mailbox_url);
          result.body_text = body.text;
          result.body_source = 'applescript';
        } catch {
          result.body_text = msg.snippet ?? null;
          result.body_source = 'snippet_only';
        }
      }

      // Build resource_link items for each attachment
      const attachmentLinks = attachmentMeta.map((a, i) => ({
        type: 'resource_link' as const,
        uri: `mail-attachment://${message_id}/${i}`,
        name: a.name || `attachment-${i}`,
        mimeType: 'application/octet-stream',
      }));

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
          ...attachmentLinks,
        ],
      };
    }
  );

  // Tool 4: search_messages
  server.tool(
    'search_messages',
    'Search messages by subject, sender, or full-text content',
    {
      query: z.string().describe('Search query'),
      limit: z.number().default(25).describe('Max results to return'),
    },
    async ({ query, limit }) => {
      const messages = db.searchMessages(query, limit);
      const result = messages.map(msg => ({
        id: msg.id,
        subject: msg.subject,
        sender: msg.sender,
        sender_name: msg.sender_name,
        date: formatDate(msg.date_received),
        read: msg.read === 1,
        snippet: msg.snippet,
        mailbox_url: msg.mailbox_url,
        conversation_id: msg.conversation_id,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool 5: get_thread
  server.tool(
    'get_thread',
    'Get all messages in a conversation thread',
    {
      conversation_id: z.number().describe('Conversation ID from a message'),
    },
    async ({ conversation_id }) => {
      const messages = db.getThread(conversation_id);
      const result = messages.map(msg => ({
        id: msg.id,
        subject: msg.subject,
        sender: msg.sender,
        sender_name: msg.sender_name,
        date: formatDate(msg.date_received),
        read: msg.read === 1,
        size: msg.size,
        snippet: msg.snippet,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool 6: send_message
  server.tool(
    'send_message',
    'Send a new email message via Apple Mail',
    {
      to: z.array(z.string()).describe('Recipient email addresses'),
      cc: z.array(z.string()).optional().describe('CC recipients'),
      bcc: z.array(z.string()).optional().describe('BCC recipients'),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Email body (plain text)'),
    },
    async ({ to, cc, bcc, subject, body }) => {
      try {
        await sendMessage({ to, cc, bcc, subject, body });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, message: 'Email sent successfully' }) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(err) }) }],
        };
      }
    }
  );

  // Tool 7: reply_to_message
  server.tool(
    'reply_to_message',
    'Reply to an existing email message via Apple Mail',
    {
      message_id: z.number().describe('Message ROWID to reply to'),
      body: z.string().describe('Reply body text'),
      reply_all: z.boolean().default(false).describe('Whether to reply to all recipients'),
    },
    async ({ message_id, body, reply_all }) => {
      const msg = db.getMessage(message_id);
      if (!msg) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Message not found' }) }],
        };
      }
      try {
        await replyToMessage({ messageId: message_id, mailboxUrl: msg.mailbox_url, body, replyAll: reply_all });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, message: 'Reply sent successfully' }) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(err) }) }],
        };
      }
    }
  );

  // Tool 8: get_attachment
  server.tool(
    'get_attachment',
    'Retrieve the contents of a message attachment by index (the "index" field from get_message). ' +
      'Reads the locally cached copy when available; otherwise asks Apple Mail to download it from the ' +
      'server (iCloud/IMAP/Exchange). Returns small text/image attachments inline; for anything else, or ' +
      'to keep the bytes out of context, pass save_path to write the file to disk and get back its path.',
    {
      message_id: z.number().describe('Message ROWID'),
      index: z.number().describe('Attachment index from get_message (the "index" field on each attachment)'),
      save_path: z
        .string()
        .optional()
        .describe('Absolute path (or ~/...) to write the attachment to. If set, the bytes are saved instead of returned inline.'),
    },
    async ({ message_id, index, save_path }) => {
      const errorResult = (msg: string) => ({
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      });

      const msg = db.getMessage(message_id);
      if (!msg) {
        return errorResult('Message not found');
      }

      // Prefer the locally cached .emlx copy when it exists.
      let att: Awaited<ReturnType<typeof getAttachmentData>> = null;
      const emlxPath = findEmlxPath(mailRoot, msg.mailbox_url, message_id);
      if (emlxPath) {
        try {
          att = await getAttachmentData(emlxPath, index);
        } catch {
          att = null; // fall through to the server download
        }
      }

      // Not cached locally (iCloud/IMAP/Exchange message whose bytes Mail hasn't
      // downloaded) — ask Apple Mail to fetch it from the server on demand.
      if (!att) {
        try {
          att = await getAttachmentViaMail(message_id, msg.mailbox_url, index);
        } catch (err) {
          return errorResult(String(err));
        }
      }

      if (!att) {
        return errorResult(`Attachment index ${index} not found in message ${message_id}`);
      }

      const meta = {
        filename: att.filename,
        content_type: att.contentType,
        size: att.data.length,
      };

      // Save to disk when requested — keeps large binaries out of the model context.
      if (save_path) {
        const target = save_path.startsWith('~/') ? join(homedir(), save_path.slice(2)) : save_path;
        if (!isAbsolute(target)) {
          return errorResult(`save_path must be an absolute path (or start with ~/): ${save_path}`);
        }
        try {
          writeFileSync(target, att.data);
        } catch (err) {
          return errorResult(`Failed to write ${target}: ${String(err)}`);
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ...meta, saved_to: target }, null, 2) }],
        };
      }

      // Inline return, sized to what's useful in context.
      const TEXT_LIMIT = 256 * 1024; // 256 KB
      const IMAGE_LIMIT = 4 * 1024 * 1024; // 4 MB
      const BLOB_LIMIT = 1 * 1024 * 1024; // 1 MB

      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'image'; data: string; mimeType: string }
        | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } }
      > = [{ type: 'text', text: JSON.stringify(meta, null, 2) }];

      const uri = `mail-attachment://${message_id}/${index}`;

      if (att.contentType.startsWith('text/') && att.data.length <= TEXT_LIMIT) {
        content.push({ type: 'text', text: att.data.toString('utf8') });
      } else if (att.contentType.startsWith('image/') && att.data.length <= IMAGE_LIMIT) {
        content.push({ type: 'image', data: att.data.toString('base64'), mimeType: att.contentType });
      } else if (att.data.length <= BLOB_LIMIT) {
        content.push({ type: 'resource', resource: { uri, mimeType: att.contentType, blob: att.data.toString('base64') } });
      } else {
        content.push({
          type: 'text',
          text:
            `Attachment is ${(att.data.length / 1024 / 1024).toFixed(1)} MB — too large to return inline. ` +
            `Re-run with save_path to write it to disk, or read the resource ${uri}.`,
        });
      }

      return { content };
    }
  );
}
