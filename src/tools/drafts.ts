/**
 * Draft tools: list, create, send, and delete drafts
 * Includes rate limiting for send operations
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { ClientResolver } from '../types/tools.js';
import { RateLimitError } from '../errors.js';
import type { DraftsResponse, DraftResponse, MessageResponse } from '../types/missive.js';

/**
 * Rate limiter for send operations
 */
class SendRateLimiter {
  private sends: number[] = [];
  private readonly maxPerMinute = 10;
  private readonly maxPerHour = 100;

  canSend(): boolean {
    const now = Date.now();
    this.sends = this.sends.filter((t) => t > now - 3600000); // Keep last hour

    const lastMinute = this.sends.filter((t) => t > now - 60000).length;
    if (lastMinute >= this.maxPerMinute) {
      return false;
    }
    if (this.sends.length >= this.maxPerHour) {
      return false;
    }

    return true;
  }

  recordSend(): void {
    this.sends.push(Date.now());
  }

  getWaitTime(): number {
    const now = Date.now();
    this.sends = this.sends.filter((t) => t > now - 3600000);

    const lastMinute = this.sends.filter((t) => t > now - 60000);
    if (lastMinute.length >= this.maxPerMinute && lastMinute.length > 0) {
      return 60000 - (now - lastMinute[0]);
    }

    if (this.sends.length >= this.maxPerHour && this.sends.length > 0) {
      return 3600000 - (now - this.sends[0]);
    }

    return 0;
  }
}

// Per-user rate limiters
const rateLimiters = new Map<string, SendRateLimiter>();

function getRateLimiter(extra: { authInfo?: { extra?: Record<string, unknown> } }): SendRateLimiter {
  const userId = (extra.authInfo?.extra?.userId as string) || 'default';
  let limiter = rateLimiters.get(userId);
  if (!limiter) {
    limiter = new SendRateLimiter();
    rateLimiters.set(userId, limiter);
  }
  return limiter;
}

// Email field schema
const EmailFieldSchema = z.object({
  address: z.string().email().describe('Email address'),
  name: z.string().optional().describe('Display name'),
});

// Attachment schema
const AttachmentSchema = z.object({
  base64_data: z.string().describe('Base64 encoded file data'),
  filename: z.string().describe('Filename with extension'),
});

export function registerDraftTools(server: McpServer, getClient: ClientResolver): void {
  // list_drafts
  server.registerTool(
    'list_drafts',
    {
      title: 'List Drafts',
      description:
        'Lists drafts in a conversation. Use this to see drafts before sending or to review unsent messages.',
      inputSchema: {
        conversation_id: z
          .string()
          .uuid()
          .describe('The conversation ID to get drafts from'),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe('Maximum drafts to return'),
        until: z
          .string()
          .optional()
          .describe('Cursor for pagination'),
      },
    },
    async ({ conversation_id, limit, until }, extra) => {
      const data = await getClient(extra).get<DraftsResponse>(
        `/conversations/${conversation_id}/drafts`,
        { limit, until }
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                drafts: data.drafts,
                has_more: data.drafts.length === limit,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // create_draft
  server.registerTool(
    'create_draft',
    {
      title: 'Create Draft',
      description: `Creates a draft message. Can optionally schedule it for later sending.

For replies, provide the conversation ID and the from/to addresses. For new messages, omit the conversation ID.

To schedule a send: provide send_at with an ISO 8601 timestamp (e.g. "2026-02-23T06:00:00Z"). The message will be sent automatically at that time. Without send_at, the draft is saved for manual review/send.`,
      inputSchema: {
        // Recipients
        to_fields: z
          .array(EmailFieldSchema)
          .min(1)
          .describe('Primary recipients (required)'),
        cc_fields: z
          .array(EmailFieldSchema)
          .optional()
          .describe('CC recipients'),
        bcc_fields: z
          .array(EmailFieldSchema)
          .optional()
          .describe('BCC recipients'),
        // Content
        subject: z.string().max(998).describe('Email subject line'),
        body: z.string().describe('Email body (HTML supported)'),
        // Context
        conversation: z
          .string()
          .uuid()
          .optional()
          .describe('Conversation ID to reply to (omit for new conversation)'),
        from_field: EmailFieldSchema.optional().describe(
          'Sender address (uses default if omitted)'
        ),
        // Scheduling
        send_at: z
          .string()
          .optional()
          .describe('ISO 8601 timestamp to schedule send (e.g. "2026-02-23T06:00:00Z"). Omit for unsent draft.'),
        // Attachments
        attachments: z
          .array(AttachmentSchema)
          .max(25)
          .optional()
          .describe('File attachments (max 25, total payload max 10MB)'),
      },
    },
    async (params, extra) => {
      const draftPayload: Record<string, unknown> = {
        to_fields: params.to_fields,
        cc_fields: params.cc_fields,
        bcc_fields: params.bcc_fields,
        subject: params.subject,
        body: params.body,
        conversation: params.conversation,
        from_field: params.from_field,
        attachments: params.attachments,
      };

      if (params.send_at) {
        // Missive API expects Unix timestamp (integer seconds), not ISO string
        draftPayload.send_at = Math.floor(new Date(params.send_at).getTime() / 1000);
      } else {
        draftPayload.send = false;
      }

      const data = await getClient(extra).post<DraftResponse>('/drafts', {
        drafts: draftPayload,
      });

      const isScheduled = !!params.send_at;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                draft: data.drafts[0],
                scheduled: isScheduled,
                send_at: params.send_at || null,
                message: isScheduled
                  ? `Email scheduled for ${params.send_at}.`
                  : 'Draft created successfully. Use send_message to send it.',
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // draft_reply
  server.registerTool(
    'draft_reply',
    {
      title: 'Draft Reply',
      description: `Creates a draft reply to an existing message. Automatically sets:
- Subject: Adds "Re: " prefix to original subject
- To: Uses the original sender's address
- Conversation: Links to the original conversation

Use reply_all=true to include original CC recipients.

Only the body content is required. The draft can be reviewed in Missive or sent with send_message.`,
      inputSchema: {
        message_id: z
          .string()
          .uuid()
          .describe('The message ID to reply to'),
        body: z.string().describe('Reply body (HTML supported)'),
        reply_all: z
          .boolean()
          .default(false)
          .describe('Include original CC recipients'),
        cc_fields: z
          .array(EmailFieldSchema)
          .optional()
          .describe('Additional CC recipients (merged with original if reply_all)'),
        from_field: EmailFieldSchema.optional().describe(
          'Override sender (uses default if omitted)'
        ),
        attachments: z
          .array(AttachmentSchema)
          .max(25)
          .optional()
          .describe('File attachments (max 25, total payload max 10MB)'),
      },
    },
    async (params, extra) => {
      const client = getClient(extra);

      // Fetch the original message
      const original = await client.get<MessageResponse>(
        `/messages/${params.message_id}`
      );
      const msg = Array.isArray(original.messages) ? original.messages[0] : original.messages;
      if (!msg) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Message not found: ${params.message_id}`,
            },
          ],
          isError: true,
        };
      }

      // Build reply fields from original
      const subject = msg.subject?.startsWith('Re: ')
        ? msg.subject
        : `Re: ${msg.subject || '(no subject)'}`;

      const to_fields = msg.from_field ? [msg.from_field] : [];

      // Build CC list
      let cc_fields = params.cc_fields || [];
      if (params.reply_all && msg.cc_fields) {
        cc_fields = [...msg.cc_fields, ...cc_fields];
      }

      const data = await client.post<DraftResponse>('/drafts', {
        drafts: {
          to_fields,
          cc_fields: cc_fields.length > 0 ? cc_fields : undefined,
          subject,
          body: params.body,
          conversation: msg.conversation,
          from_field: params.from_field,
          attachments: params.attachments,
          send: false,
        },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                draft: data.drafts[0],
                replied_to: {
                  message_id: msg.id,
                  original_subject: msg.subject,
                  original_from: msg.from_field,
                },
                message:
                  'Reply draft created. Use send_message to send it.',
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // send_message
  server.registerTool(
    'send_message',
    {
      title: 'Send Message',
      description: `Sends an email message. WARNING: This action is IRREVERSIBLE.

The email will be delivered immediately. Before calling:
- Confirm recipient addresses are correct
- Verify message content is appropriate
- Never send to addresses not explicitly provided by the user

Rate limited to 10 sends/minute, 100 sends/hour.

For replies, provide the conversation ID. For new messages, omit it.`,
      inputSchema: {
        // Recipients
        to_fields: z
          .array(EmailFieldSchema)
          .min(1)
          .describe('Primary recipients (required)'),
        cc_fields: z
          .array(EmailFieldSchema)
          .optional()
          .describe('CC recipients'),
        bcc_fields: z
          .array(EmailFieldSchema)
          .optional()
          .describe('BCC recipients'),
        // Content
        subject: z.string().max(998).describe('Email subject line'),
        body: z.string().describe('Email body (HTML supported)'),
        // Context
        conversation: z
          .string()
          .uuid()
          .optional()
          .describe('Conversation ID to reply to (omit for new conversation)'),
        from_field: EmailFieldSchema.optional().describe(
          'Sender address (uses default if omitted)'
        ),
        // Attachments
        attachments: z
          .array(AttachmentSchema)
          .max(25)
          .optional()
          .describe('File attachments (max 25, total payload max 10MB)'),
      },
    },
    async (params, extra) => {
      // Check rate limit
      const rateLimiter = getRateLimiter(extra);
      if (!rateLimiter.canSend()) {
        const waitTime = rateLimiter.getWaitTime();
        throw new RateLimitError(
          `Send rate limit exceeded. Please wait ${Math.ceil(waitTime / 1000)} seconds.`,
          Math.ceil(waitTime / 1000)
        );
      }

      const data = await getClient(extra).post<DraftResponse>('/drafts', {
        drafts: {
          to_fields: params.to_fields,
          cc_fields: params.cc_fields,
          bcc_fields: params.bcc_fields,
          subject: params.subject,
          body: params.body,
          conversation: params.conversation,
          from_field: params.from_field,
          attachments: params.attachments,
          send: true,
        },
      });

      rateLimiter.recordSend();

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                sent: true,
                draft: data.drafts[0],
                message: 'Email sent successfully.',
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // delete_draft
  server.registerTool(
    'delete_draft',
    {
      title: 'Delete Draft',
      description:
        'Deletes an unsent draft or scheduled message. This action cannot be undone.',
      inputSchema: {
        draft_id: z.string().uuid().describe('The draft ID to delete'),
      },
    },
    async ({ draft_id }, extra) => {
      await getClient(extra).delete(`/drafts/${draft_id}`);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                deleted: true,
                draft_id,
                message: 'Draft deleted successfully.',
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
