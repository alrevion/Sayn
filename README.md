# Sayn

A kanban board for small teams, wired into Telegram. Live at [sayn.alrevion.com](https://sayn.alrevion.com).
Sayn (July–September 2026) is the predecessor of [Hando](https://github.com/alrevion/Hando), which added voice input
and personal tasks on top of it.

## What it does

- Projects, each with its own Telegram group; members and roles.
- Tasks with status (`todo` / `in_progress` / `done` / `archived`), deadline, priority and dependencies.
- Reminders a day before the deadline and escalation of reviews left hanging (cron).
- Attachments stored in a bot-only Telegram group; a Notion-like task body with text and images.
- An append-only `events` log: who did what, to which task, when.
- An MCP server so AI agents can read and update the board.

## Stack

Cloudflare Workers + Hono, D1 (SQLite), React + Vite (`frontend/`), Telegram Bot API.

```bash
npm install
npm test
npm run dev
```

---

© 2026 Alrevion. Source published for review; all rights reserved.
