#!/usr/bin/env node
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { MailDB, getMailRoot } from './db.js';
import { registerTools } from './tools.js';
import { findEmlxPath, getAttachmentData } from './emlx.js';

const PORT = parseInt(process.env.MCP_MAIL_PORT ?? '3745', 10);

function registerResources(server: McpServer, db: MailDB, mailRoot: string): void {
  // Resource: mail-attachment://{messageId}/{index}
  server.registerResource(
    'mail-attachment',
    new ResourceTemplate('mail-attachment://{messageId}/{index}', { list: undefined }),
    {
      title: 'Mail Attachment',
      description: 'Binary attachment from an email message',
    },
    async (uri, { messageId, index }) => {
      const msgId = parseInt(String(messageId), 10);
      const attIndex = parseInt(String(index), 10);

      const msg = db.getMessage(msgId);
      if (!msg) {
        throw new Error(`Message ${msgId} not found`);
      }

      const emlxPath = findEmlxPath(mailRoot, msg.mailbox_url, msgId);
      if (!emlxPath) {
        throw new Error(`EMLX not available for message ${msgId} (EWS-only message)`);
      }

      const att = await getAttachmentData(emlxPath, attIndex);
      if (!att) {
        throw new Error(`Attachment index ${attIndex} not found in message ${msgId}`);
      }

      return {
        contents: [{
          uri: uri.href,
          blob: att.data.toString('base64'),
          mimeType: att.contentType,
        }],
      };
    }
  );
}

async function main() {
  const db = new MailDB();
  const mailRoot = getMailRoot();

  const app = createMcpExpressApp();

  app.post('/mcp', async (req, res) => {
    const server = new McpServer({ name: 'apple-mail', version: '1.0.0' });
    registerTools(server, db, mailRoot);
    registerResources(server, db, mailRoot);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const httpServer = app.listen(PORT, '127.0.0.1', () => {
    process.stderr.write(`apple-mail MCP server listening on http://127.0.0.1:${PORT}/mcp\n`);
  });

  const shutdown = () => {
    db.close();
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
