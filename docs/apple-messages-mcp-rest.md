# Apple Messages MCP REST capabilities

The authenticated routes below are the reusable Messages backend for the standalone Java MCP bridge. They inherit the normal BlueBubbles password middleware and are read-only. Mutation routes continue to use the existing Private API endpoints.

| Route                                             | Backend responsibility                                                                                                | Bound                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `POST /api/v1/message/mcp/history`                | Exact chat/contact history, keyset ordering, native Apple timestamps, and optional TheFuzz-compatible message scores  | 101 rows, 4 MiB serialized response, 8,000,000 fuzzy cell-work units                                   |
| `POST /api/v1/message/mcp/chats`                  | Complete exact chat catalog, including chats without participant rows                                                 | 100 rows and 128 KiB per page                                                                          |
| `POST /api/v1/message/mcp/event-evidence`         | Native event fields, source identity, associations, and high-water marks                                              | 1,250 rows and 4 MiB                                                                                   |
| `POST /api/v1/message/mcp/contacts`               | Contact-name/nickname matching and stable address-level scores                                                        | 100 rows and 128 KiB                                                                                   |
| `POST /api/v1/message/mcp/activity`               | Detailed exact-alias activity across every shared chat: body status, sender, participants, reactions, and attachments | 20 message/chat pairs and 128 KiB                                                                      |
| `POST /api/v1/message/mcp/attachments`            | Exact attachment ROWID lookup or bounded metadata search; includes the local source path but no bytes                 | 100 rows and 256 KiB                                                                                   |
| `POST /api/v1/message/mcp/attachments/transcribe` | Offline local ffmpeg plus Whisper transcription for one exact audio attachment                                        | Root-confined non-symlink source; 8 MiB/300 s/64 KiB; one async job; 10 s decode plus 25 s recognition |

Fuzzy history requests must supply `searchTerm` and `threshold` together. A shared computation budget covers the complete selected page; an over-budget request fails before any response rows or continuation state are returned. Scores are checked against independent Python `thefuzz==0.22.1` goldens, including its ties-to-even integer rounding.

Contact matching deduplicates by normalized address and returns `totalMatches` plus `truncated`. The bridge requests the maximum 100 rows and fails explicitly with a more-specific-name instruction if that bound is exceeded; it never treats a truncated page as a unique match or complete ambiguity list.

The MCP adapter retains protocol framing, untrusted-output wrapping, pagination cursor signing/binding, presentation, durable group/attachment claims, uncertain-send reconciliation, and event subscription delivery. It does not query Messages SQLite, calculate fuzzy/contact/activity results, or scan generic message responses for attachment metadata in production.

## 18-tool ownership matrix

| MCP tool                           | BlueBubbles REST/native owner                                                                           | Java MCP owner                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `tool_send_attachment`             | Private API attachment send                                                                             | durable claim, staging, one-dispatch rule                             |
| `tool_get_attachment_send_status`  | message evidence                                                                                        | durable reconciliation/report                                         |
| `tool_create_group_and_send`       | Private API availability and group creation                                                             | validation, durable claim, one-dispatch rule                          |
| `tool_get_group_creation_status`   | message/chat evidence                                                                                   | durable reconciliation/report                                         |
| `tool_event_status`                | exact event evidence                                                                                    | durable worker status                                                 |
| `tool_get_latest_contact_activity` | `/mcp/activity`                                                                                         | timezone presentation and MCP wrapping                                |
| `tool_get_recent_messages`         | `/mcp/history`                                                                                          | opaque filter-bound cursor and presentation                           |
| `tool_mark_read`                   | existing chat read route                                                                                | exact-chat resolution and MCP wrapping                                |
| `tool_send_message`                | existing Private API text route                                                                         | recipient/chat selection and MCP wrapping                             |
| `tool_find_contact`                | `/mcp/contacts`                                                                                         | presentation and `contact:N` session selection                        |
| `tool_check_db_access`             | existing authenticated ping/data route                                                                  | health wording                                                        |
| `tool_check_contacts`              | existing contact route                                                                                  | bounded diagnostic presentation                                       |
| `tool_check_addressbook`           | existing contact route                                                                                  | diagnostic presentation                                               |
| `tool_get_chats`                   | `/mcp/chats`                                                                                            | presentation                                                          |
| `tool_check_imessage_availability` | existing Private API availability route                                                                 | presentation                                                          |
| `tool_fuzzy_search_messages`       | `/mcp/history` scoring and threshold decision                                                           | opaque cursor and presentation                                        |
| `tool_search_attachments`          | `/mcp/attachments`                                                                                      | presentation                                                          |
| `tool_get_attachment`              | `/mcp/attachments`, bounded local transcription, and converted GUID download for HEIC/HEIF/TIFF and CAF | path fallback, untrusted text metadata, and inline MCP media envelope |
