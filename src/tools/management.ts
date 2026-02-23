/**
 * Conversation management tools: create posts, close, label, assign
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { ClientResolver } from '../types/tools.js';
import type { PostResponse } from '../types/missive.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function registerManagementTools(server: McpServer, getClient: ClientResolver): void {
  // batch_close — close multiple conversations cleanly (close + delete post)
  //
  // WHY THE DELETE STEP:
  // Missive API has NO way to close a conversation without creating a post.
  // The post stays UNREAD even when an Org Rule marks messages as read on close.
  // This defeats the purpose — closing should = marking as read.
  //
  // SOLUTION (tested Feb 2026):
  // 1. Create post with close=true → conversation closes, post is created
  // 2. Immediately delete the post → close persists, unread indicator disappears
  //
  // DO NOT remove the delete step. Without it, every close floods the inbox
  // with unread posts. This was tested extensively and caused real damage.
  server.registerTool(
    'batch_close',
    {
      title: 'Batch Close Conversations',
      description: `Closes multiple conversations cleanly — no unread indicators left behind.

For each conversation: creates a post to trigger the close, then immediately deletes the post
so it doesn't leave an unread item in the inbox.

Returns a summary of successes and failures.`,
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
      const results: { id: string; ok: boolean; postDeleted: boolean; error?: string }[] = [];

      for (const id of params.conversation_ids) {
        try {
          // Step 1: Close the conversation (creates a post)
          const data = await client.post<PostResponse>('/posts', {
            posts: {
              conversation: id,
              organization: params.organization,
              close: true,
              text: '\u200B',
              notification: { title: '', body: '' },
            },
          });

          // Step 2: Delete the post so it doesn't stay as unread
          // Note: Missive API returns posts as object {id, ...}, NOT array [{id, ...}]
          let postDeleted = false;
          const posts = data.posts as unknown;
          const postId = Array.isArray(posts) ? posts[0]?.id : (posts as Record<string, unknown>)?.id;
          if (postId) {
            try {
              await client.delete(`/posts/${postId}`);
              postDeleted = true;
            } catch {
              // Post deletion failed — close still worked, but unread indicator may remain
            }
          }

          results.push({ id, ok: true, postDeleted });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          results.push({ id, ok: false, postDeleted: false, error: message });
        }

        // Small delay between closes
        if (params.conversation_ids.indexOf(id) < params.conversation_ids.length - 1) {
          await sleep(500);
        }
      }

      const succeeded = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok).length;
      const postsDeleted = results.filter((r) => r.postDeleted).length;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                closed: succeeded,
                posts_cleaned: postsDeleted,
                failed,
                total: params.conversation_ids.length,
                failures: results.filter((r) => !r.ok),
                unclean: results.filter((r) => r.ok && !r.postDeleted).map((r) => r.id),
                message:
                  failed === 0
                    ? `Closed ${succeeded} conversation(s), cleaned ${postsDeleted} post(s).`
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

  // delete_post
  server.registerTool(
    'delete_post',
    {
      title: 'Delete Post',
      description:
        'Deletes a post by ID. Used to clean up posts after state changes (e.g., close) to avoid leaving unread items.',
      inputSchema: {
        post_id: z.string().uuid().describe('The post ID to delete'),
      },
    },
    async ({ post_id }, extra) => {
      await getClient(extra).delete(`/posts/${post_id}`);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                deleted: true,
                post_id,
                message: 'Post deleted successfully.',
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
