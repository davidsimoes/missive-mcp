/**
 * Conversation management tools: create posts, close, label, assign
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { ClientResolver } from '../types/tools.js';
import type { PostResponse } from '../types/missive.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function registerManagementTools(server: McpServer, getClient: ClientResolver): void {
  // batch_close — close multiple conversations with minimal notification noise
  server.registerTool(
    'batch_close',
    {
      title: 'Batch Close Conversations',
      description: `Closes multiple conversations sequentially with minimal notification noise.

Uses zero-width space text and empty notifications to minimize Missive sidebar clutter.
Adds a 500ms delay between closes to spread out any notifications.

Returns a summary of successes and failures.

IMPORTANT: Missive API has no way to close silently — each close creates a post.
Use this instead of calling create_post in parallel to reduce notification spam.`,
      inputSchema: {
        organization: z
          .string()
          .uuid()
          .describe('Organization ID'),
        conversation_ids: z
          .array(z.string().uuid())
          .min(1)
          .max(50)
          .describe('Conversation IDs to close (max 50)'),
      },
    },
    async (params, extra) => {
      const client = getClient(extra);
      const results: { id: string; ok: boolean; error?: string }[] = [];

      for (const id of params.conversation_ids) {
        try {
          await client.post<PostResponse>('/posts', {
            posts: {
              conversation: id,
              organization: params.organization,
              close: true,
              text: '\u200B',
              notification: { title: '', body: '' },
            },
          });
          results.push({ id, ok: true });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          results.push({ id, ok: false, error: message });
        }

        // Small delay between closes to spread out notifications
        if (params.conversation_ids.indexOf(id) < params.conversation_ids.length - 1) {
          await sleep(500);
        }
      }

      const succeeded = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok).length;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                closed: succeeded,
                failed,
                total: params.conversation_ids.length,
                failures: results.filter((r) => !r.ok),
                message:
                  failed === 0
                    ? `Successfully closed ${succeeded} conversation(s).`
                    : `Closed ${succeeded}, failed ${failed} of ${params.conversation_ids.length}.`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // create_post
  server.registerTool(
    'create_post',
    {
      title: 'Create Post',
      description: `Adds a post to a conversation and optionally changes its state.

This tool can:
- Close a conversation: set close=true
- Add labels: set add_shared_labels=[label_ids]
- Remove labels: set remove_shared_labels=[label_ids]
- Assign users: set add_assignees=[user_ids]
- Move to team: set team=team_id (use force_team=true to override existing team)
- Add a visible note: set text="your message"

Posts leave a visible trace showing what triggered the action.

Required: conversation and organization IDs.
Use list_organizations to get org ID, list_users for user IDs, list_shared_labels for label IDs.`,
      inputSchema: {
        // Required
        conversation: z
          .string()
          .uuid()
          .describe('Conversation ID (required)'),
        organization: z
          .string()
          .uuid()
          .describe('Organization ID (required)'),

        // State changes
        close: z
          .boolean()
          .optional()
          .describe('Set to true to close the conversation'),
        add_shared_labels: z
          .array(z.string().uuid())
          .optional()
          .describe('Label IDs to add to the conversation'),
        remove_shared_labels: z
          .array(z.string().uuid())
          .optional()
          .describe('Label IDs to remove from the conversation'),
        add_assignees: z
          .array(z.string().uuid())
          .optional()
          .describe('User IDs to assign to the conversation'),
        team: z
          .string()
          .uuid()
          .optional()
          .describe('Team ID to move conversation to'),
        force_team: z
          .boolean()
          .optional()
          .describe('Force team change even if already in another team'),

        // Content
        text: z
          .string()
          .optional()
          .describe('Post body text (visible in conversation)'),
        notification: z
          .object({
            title: z.string().describe('Notification title'),
            body: z.string().describe('Notification body'),
          })
          .optional()
          .describe('Optional notification to display'),
      },
    },
    async (params, extra) => {
      // Build post body, stripping undefined values to avoid API validation errors
      const post: Record<string, unknown> = {
        conversation: params.conversation,
        organization: params.organization,
      };

      // State changes
      if (params.close !== undefined) post.close = params.close;
      if (params.add_shared_labels?.length) post.add_shared_labels = params.add_shared_labels;
      if (params.remove_shared_labels?.length) post.remove_shared_labels = params.remove_shared_labels;
      if (params.add_assignees?.length) post.add_assignees = params.add_assignees;
      if (params.team) post.team = params.team;
      if (params.force_team) post.force_team = params.force_team;

      // Content — Missive API requires text/markdown/attachments + notification for every post.
      // Auto-generate minimal content when caller only wants state changes (e.g. silent close).
      if (params.text) {
        post.text = params.text;
      } else {
        // Minimal text so the API accepts the post
        post.text = '\u200B'; // zero-width space — invisible in Missive UI
      }

      if (params.notification) {
        post.notification = params.notification;
      } else {
        // Minimal notification — required by API
        post.notification = { title: '', body: '' };
      }

      const data = await getClient(extra).post<PostResponse>('/posts', {
        posts: post,
      });

      const actions: string[] = [];
      if (params.close) actions.push('closed');
      if (params.add_shared_labels?.length)
        actions.push(`added ${params.add_shared_labels.length} label(s)`);
      if (params.remove_shared_labels?.length)
        actions.push(`removed ${params.remove_shared_labels.length} label(s)`);
      if (params.add_assignees?.length)
        actions.push(`assigned ${params.add_assignees.length} user(s)`);
      if (params.team) actions.push('moved to team');
      if (params.text) actions.push('added note');

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                post: data.posts[0],
                actions_performed: actions.length > 0 ? actions : ['created post'],
                message: 'Post created successfully.',
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
