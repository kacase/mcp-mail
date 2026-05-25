import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MailDB } from './db.js';
import { findEmlxPath, parseEmlx } from './emlx.js';
import { sendMessage, replyToMessage, getMessageBody } from './applescript.js';

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
        attachments: attachmentMeta.map(a => ({
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

  // Attachments are served as MCP resources via mail-attachment://{messageId}/{index}
  // registered in index.ts via ResourceTemplate — no tool needed.
}
