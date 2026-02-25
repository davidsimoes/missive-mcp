# Project: Missive MCP Server

## Tech Stack
- Language: TypeScript
- Framework: Node.js 18+, MCP SDK (@modelcontextprotocol/sdk)
- Key dependencies: Express 5.x (remote mode), Zod (validation), TypeScript 5.x

## Architecture

MCP server for the Missive email API with two deployment modes:

**Stdio Mode** (`npm start`)
- Single-user, local development
- Reads `MISSIVE_API_TOKEN` from environment
- Connects via stdio transport to Claude Desktop

**Remote Mode** (`npm run remote`)
- Hosted HTTP server with OAuth 2.0 authorization
- Per-user encryption of Missive PATs (AES-256-GCM)
- Requires `ENCRYPTION_KEY`, `BASE_URL`, optional `PORT` and `DATA_DIR`
- Clients connect via HTTPS to `{BASE_URL}/mcp`

### Core Structure

**Entry points:**
- `src/index.ts` — stdio mode initialization
- `src/server.ts` — remote mode HTTP server + OAuth

**API Client:**
- `src/client.ts` — `MissiveClient` singleton/factory with typed error handling (AuthError, RateLimitError, NotFoundError)
- Token redaction in all error messages
- Per-token WeakRef cache in remote mode

**Tool Organization** (`src/tools/`):
- `reference.ts` — Organizations, teams, users, contact books, shared labels (with per-user TTL caching)
- `conversations.ts` — List and fetch conversations with filtering
- `messages.ts` — `get_message` and `get_conversation_timeline` (unified view: messages + posts + comments)
- `drafts.ts` — Create, send, and delete drafts (rate limited: 10/min, 100/hr)
- `contacts.ts` — CRUD operations on contacts
- `management.ts` — `create_post` for closing, labeling, assigning, and routing conversations

**Auth** (`src/auth/`):
- `provider.ts` — OAuth authorization server implementation
- `storage.ts` — File-based JSON storage with AES-256-GCM PAT encryption
- `authorize-page.ts` — HTML form for PAT input

**Types & Utilities:**
- `src/types/missive.ts` — Missive API response types; `TimelineItem` is discriminated union (message | post | comment)
- `src/types/tools.ts` — `ClientResolver` type for auth-aware tool callbacks
- `src/cache.ts` — Per-conversation timeline cache; smart stop-on-hit fetching
- `src/errors.ts` — Typed error classes for API error handling

## Conventions

- **Naming:** Tools follow pattern `list_*`, `get_*`, `create_*`, `update_*`, `delete_*`, `send_*`
- **Auth:** Tool callbacks receive `(params, extra)` where `extra.authInfo.extra.missiveToken` resolves the user's token in remote mode
- **Tool registration:** Each tool module exports `registerXxxTools(server, getClient)` and registers 1+ tools
- **Error handling:** All API errors caught as `AuthError`, `RateLimitError`, `NotFoundError` with token-safe messages
- **Caching:** Reference data (users, teams, labels) cached per-user with TTL; conversation timelines cached per-conversation

## Key Commands

```bash
npm run build         # Compile TypeScript to dist/
npm run dev          # Watch mode (tsc --watch)
npm start            # Run stdio server (requires MISSIVE_API_TOKEN)
npm run remote       # Run HTTP server (requires ENCRYPTION_KEY, BASE_URL)
```

No test suite. Manual testing via MCP clients or direct HTTP requests.

## Gotchas

1. **Node path in Claude Desktop config** — Must be full path from `which node`, not just "node" (Claude Desktop has restricted PATH)
2. **Missive API requires Productive plan** — Free accounts won't work; plan requirement is not validated until first API call
3. **Rate limiting on send_message** — Client enforces 10/min, 100/hr; hitting this blocks the tool until window resets
4. **Timeline caching stops at first unchanged item** — `get_conversation_timeline` fetches backward from latest until it sees an item already in cache; if conversation is very active, may need refetch strategy
5. **Remote mode encryption key generation** — Use `openssl rand -hex 32` for 32-byte hex string; mismatch with stored key = decryption failure
6. **OAuth token expiry** — Access tokens expire after 1 hour; refresh tokens last 30 days; clients must handle refresh flow
7. **Post state quirk** — Creating a post to close a conversation leaves an unread post; `batch_close` MCP tool works around this with delete, but raw API calls won't
8. **Missive API docs incomplete** — Rate limits undocumented; error codes not fully specified; rely on 429 responses and HTTP status codes
