# -welloff-neural-link
my Base  Universal AGENT

## IDE

`npm run dev`, then open http://localhost:3001.

- **Editor**: file explorer, TypeScript editor, quick open (`Ctrl+P`), save (`Ctrl+S`), typecheck (`Ctrl+Shift+B`), terminal for running agents.
- **Agent panel** (`Ctrl+L`) and **Agent Manager** (`Ctrl+E`): describe a change; the coding agent plans, reads code, proposes edits and typechecks. Each edit is a diff you accept or reject. Set `IDE_AGENT_MODEL` to change the model (default `claude-opus-5-5`).
- **Deployments**: `Local` builds an immutable snapshot of the workspace, runs it on its own port, and shows build and runtime logs plus a live preview. Promote a ready deployment to production at http://localhost:4000 (`NL_PROD_PORT`); promoting an older one is an instant rollback. Production is restored when the server restarts.
- **Netlify / Vercel**: publish the static IDE and dashboard. Add `NETLIFY_AUTH_TOKEN` (optional `NETLIFY_SITE_ID`) or `VERCEL_TOKEN` (optional `VERCEL_TEAM_ID`, `VERCEL_PROJECT`) under Environment.
- **Environment**: edit `.env` with values hidden. Changes apply to new deployments and the next restart.

The IDE API writes files, edits `.env` and starts processes, so it accepts only same-origin requests from localhost. Set `NEURAL_API_KEY` to allow remote access.
