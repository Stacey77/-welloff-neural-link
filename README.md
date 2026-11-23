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

## Multi-LLM and MAESTRO

Neural-link calls Claude, OpenAI, Gemini, Grok, Mistral, DeepSeek, Groq, OpenRouter and local Ollama through one layer (`src/llm`). MAESTRO, the conductor agent, picks a model per request from the task type and the routing policy (quality, balanced, economy, speed), and falls back to the next configured provider when a call fails or is declined. TON, BRAIN, NATURA, GENESIS, the IDE coding agent and the council judge can each be pinned to a model or left on Auto, in the IDE's **Models** surface. The Arena there runs one prompt on several models; council mode has a judge score the anonymized answers and write a combined one.

Add a provider by setting its key (see `.env.example`). Claude model IDs are built in; for other providers use **Discover models** to load their current list.

## Integrations

- **LangSmith**: set `LANGSMITH_API_KEY` (and optionally `LANGSMITH_PROJECT`). Agent runs, model calls and tool calls are sent as nested traces with token usage.
- **LangChain**: `/v1` is an OpenAI-compatible endpoint over the router. Use `ChatOpenAI` with `configuration: { baseURL: 'http://localhost:3001/v1' }` and model `auto`, `auto:speed` or any `provider:model`. Tool calling and streaming work.
- **Lindy.ai**: set `LINDY_WEBHOOK_URL` (your Lindy agent's webhook trigger) to let agents trigger Lindy workflows (`LINDY.trigger`, and the IDE agent's `trigger_lindy` tool). Set `LINDY_INBOUND_SECRET` to let a Lindy HTTP Request action call `POST /integrations/lindy` with `Authorization: Bearer <secret>` and a body of `{ "message": "..." }` or `{ "agentId", "command", "params" }`.

The `/v1` gateway and Lindy inbound endpoint spend your provider keys, so the gateway only accepts localhost unless `NEURAL_API_KEY` is set, and the Lindy endpoint refuses every call until `LINDY_INBOUND_SECRET` is set.
