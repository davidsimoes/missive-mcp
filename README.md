# Missive MCP Server

An MCP (Model Context Protocol) server that interfaces with the [Missive API](https://missiveapp.com/docs/developers/rest-api/endpoints), enabling Claude to manage email conversations, contacts, and team collaboration.

## Prerequisites

- Node.js 18+
- Missive account with **Productive plan** (required for API access)
- Missive API token

## Installation

```bash
npm install
npm run build
```

## Modes

The server runs in two modes: **stdio** for local single-user use, and **remote** for hosted multi-user deployments.

### Stdio Mode (Local)

Set the `MISSIVE_API_TOKEN` environment variable:

```bash
export MISSIVE_API_TOKEN="your_api_token_here"
npm start
```

To get your API token: open Missive, go to Settings > API, click "Create a new token".

Add to your Claude Desktop configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "missive": {
      "command": "/path/to/node",
      "args": ["/path/to/missive-mcp/dist/index.js"],
      "env": {
        "MISSIVE_API_TOKEN": "your_api_token_here"
      }
    }
  }
}
```

**Important:** Use the full path to `node` (run `which node` to find it). Claude Desktop has a restricted PATH and may not find node otherwise.

### Remote Mode (Hosted)

Runs an HTTP server with OAuth. Each user provides their own Missive PAT through a browser-based authorization flow.

```bash
export ENCRYPTION_KEY="$(openssl rand -hex 32)"
export BASE_URL="https://missive-mcp.example.com"
npm run remote
```

| Variable | Required | Description |
|---|---|---|
| `ENCRYPTION_KEY` | Yes | 32-byte hex string for AES-256-GCM PAT encryption |
| `BASE_URL` | Yes | Public URL of the server |
| `PORT` | No | HTTP port (default 3000) |
| `DATA_DIR` | No | Directory for storage files (default `./data`) |

Point MCP clients at `{BASE_URL}/mcp`. The server handles OAuth automatically:

1. Client discovers endpoints via `/.well-known/oauth-authorization-server`
2. Client registers dynamically via `/register`
3. User is redirected to a form to paste their Missive API token
4. Server validates the token, encrypts and stores it, issues OAuth tokens
5. Client uses bearer tokens to call `/mcp`

PATs are encrypted at rest with AES-256-GCM. OAuth tokens expire after 1 hour (refresh tokens last 30 days).

## Tools

### Reference Data

| Tool | Description |
|------|-------------|
| `list_organizations` | List organizations you belong to |
| `list_teams` | List teams (for assignments) |
| `list_users` | List users (for assignments) |
| `list_contact_books` | List contact books (required before creating contacts) |
| `list_shared_labels` | List labels (for filtering and tagging) |

### Conversations

| Tool | Description |
|------|-------------|
| `list_conversations` | List conversations with filters (inbox, assigned, closed, team, label, email, domain) |
| `get_conversation` | Get a single conversation by ID |

### Messages

| Tool | Description |
|------|-------------|
| `get_conversation_timeline` | Get all messages, posts, and comments as a unified chronological timeline |
| `get_message` | Get full message content (with body truncation options) |

### Drafts

| Tool | Description |
|------|-------------|
| `list_drafts` | List drafts in a conversation |
| `create_draft` | Create a draft (not sent) |
| `send_message` | Send a message immediately (rate limited) |
| `delete_draft` | Delete an unsent draft |

### Contacts

| Tool | Description |
|------|-------------|
| `list_contacts` | List contacts in a book (with search) |
| `get_contact` | Get a single contact |
| `create_contact` | Create a new contact |
| `update_contact` | Update an existing contact |

### Management

| Tool | Description |
|------|-------------|
| `create_post` | Add a post to a conversation; close, label, assign, mention users, or move to team |
| `batch_close` | Close multiple conversations cleanly (auto-deletes the state-change post to avoid unread items) |
| `mark_as_read` | Mark a conversation as read without closing it (requires `_api-read` label + org rule) |

## Examples

### Read inbox
```
Use list_conversations with inbox=true to see recent conversations.
```

### Reply to an email
```
1. Use list_conversations to find the conversation
2. Use get_conversation_timeline to see the full thread (messages + team activity)
3. Use send_message with the conversation ID to reply
```

### Search for emails from a domain
```
Use list_conversations with domain="example.com"
```

### Assign a conversation
```
1. Use list_users to find the user ID
2. Use list_organizations to get the org ID
3. Use create_post with add_assignees=[user_id]
```

## Known Missive API Limitations

These are workarounds for gaps in the Missive REST API. We've filed feature requests for proper endpoints.

### No silent close
The API has no way to close a conversation without creating a visible post. `batch_close` works around this by creating a post with `close: true`, then immediately deleting it. The close persists, the unread post disappears.

### No mark-as-read endpoint
There's no API endpoint to mark a conversation as read. `mark_as_read` works around this by adding a label (`_api-read`) that triggers an Org Rule configured in Missive to mark conversations as read. The tool then cleans up the label and posts. **Requires a one-time Org Rule setup in Missive.**

### No comment creation
The API can read comments (`GET /conversations/:id/comments`) but cannot create them. Posts are the only writable content type. This means inline @mentions (which render as highlighted badges in comments) aren't possible via API — `mention_ids` on posts triggers notifications but renders as plain text.

### Undocumented rate limits
Missive API rate limits aren't published. The server handles 429 responses and enforces conservative client-side limits on send operations.

## Rate Limits

- `send_message`: 10 per minute, 100 per hour (client-enforced)
- Missive API rate limits are undocumented; the client handles 429 responses

## Security

- API tokens are validated on startup (stdio) or on authorization (remote)
- Tokens are never logged or included in error messages
- In remote mode, PATs are encrypted at rest with AES-256-GCM
- Email body content is never logged
- Input validation on all tool parameters

## License

MIT
