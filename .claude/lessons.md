# Lessons Learned

Corrections, mistakes, and project-specific rules captured during work sessions.

---

## 2026-03-01 — mention_ids on posts renders as plain text

**Context**: Tried to @mention Kuba and Robin in a Missive conversation via API
**Lesson**: `mention_ids` on `POST /posts` is accepted by the API without error and may trigger notifications, but mentions render as plain text — not as highlighted badges like in the UI. Visual mentions only exist in comments, which are read-only via API (no POST endpoint). The `markdown` field works fine for post body content.
**Rule**: To notify users via API, use `add_assignees` — it creates a real, visible notification. Don't rely on `mention_ids` for user-facing mention UX. Feature request filed: https://feedback.missiveapp.com/feature-requests/p/rest-api-create-comments-render-mentions-and-mark-as-read
