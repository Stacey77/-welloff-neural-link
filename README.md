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

## Security

Security in the IDE, or `nl security status`.

- **Guardrails** on every model call, Lindy webhook and `/v1` request: secrets and personal data are detected and redacted before leaving (each value becomes a token kept in server memory, restored only when the IDE agent writes a file), prompt-injection text in tool results is quarantined, and model output is scanned for leaked secrets. Modes per category: off, monitor, redact (or quarantine), block. Tools can be denied per agent.
- **AI security**: discovers every agent file and flags ones the router does not run (GENESIS output lands here), maps data flows and exposed endpoints, scans src/ for secrets and checks .env is not committed.
- **Email security**: paste a message's source to check SPF/DKIM/DMARC results, lookalike domains (set `NL_PROTECTED_DOMAINS`), display-name spoofing, link tricks, risky attachments and phishing language, with an optional AI second opinion.
- **DMARC analyzer**: DMARC, SPF (including the 10-lookup limit) and DKIM via DNS, a grade, the next record to publish, and aggregate-report summaries.
- **Behaviour**: per-agent risk from its own risky actions, decayed over 7 days, with coach, review and restrict interventions.
- **Data governance**: append-only, hash-chained archive of model calls, Lindy messages, emails and incidents, with search, export, retention and legal holds.
- **Threat response**: every 5 minutes, events are correlated into incidents, triaged by a model and sent to Lindy when high or critical.

## Tool access beyond MCP

- **Skills**: procedures in `skills/<name>/SKILL.md`. Agents see one line per skill and load the rest on demand.
- **Progressive tool access** (default): agents get `search_tools`, `call_tool`, `list_skills` and `load_skill` instead of every MCP definition.
- **Code execution** (opt-in): agents write JavaScript that calls tools and returns only the result. It runs in a child process under Node's permission model with an empty environment, memory cap and timeouts. This is a strong restriction, not a hardened sandbox.
- **CLI**: `npm run build`, then `node dist/cli.js help`.

## EVE

An assistant with lasting memory of your LLCs, clients, projects, prospects and deadlines. She extracts them from conversation, reminds you 7 days and 1 day before deadlines and on the day, and turns inbound webhooks into notifications. Point Zapier, Make, Lindy or Calendly at `POST /assistant/events` with `Authorization: Bearer <ASSISTANT_WEBHOOK_SECRET>`.

## Engineering

AXIOM turns a plain-language goal into an architecture plan, a 16-node swarm sizes each component (MORTEX picks materials, SENTINEL checks safety), and every design is verified with a 1D beam FEA solver and thermal checks. Stream sensor readings to `/ide/api/engineering/projects/<id>/telemetry`, or start the labelled simulator, to keep verifying live. Results are engineering aids; stress concentrations, welds and full 3D effects still need a qualified engineer's review.

## Harness and context engineering

- **Harness**: TON, BRAIN, the streaming endpoint and the IDE agent share one loop with per-agent limits on steps, tokens, cost and tool time, schema validation of tool inputs, and detection of repeated identical calls.
- **Context engineering**: each step records what fills the context window (system, tools, history, tool results). Oversized tool results are clipped, and long runs are compacted into a fresh transcript built from a summary, so no provider is sent an edited history.
- **Evals**: suites in `evals/*.json` run cases against several models or agents with exact checks and an LLM judge. Run them in the IDE's Harness screen.

## Jobs: automatic dispatch to agents and subagents

Give TON a job in the IDE's **Jobs** screen, with `job <description>` in the terminal, `TON.job` via `/dispatch`, or `POST /jobs` with `Authorization: Bearer <JOBS_WEBHOOK_SECRET>`. TON plans it from a capability registry of every agent (or by keyword when no model is configured), runs the tasks in dependency order and in parallel where possible, and spawns general subagents for research and drafting. Each task reports to TON over the A2A bus (`job.report`), and TON writes the final report, which also arrives as an EVE notification.

Commands that spend money, deploy, send messages or change records wait for approval unless the job allows them. Jobs start on their own from triggers (serious security incidents, engineering telemetry failures, prospect replies, bookings, deadlines due tomorrow, and scheduled scans), each of which can be turned off or set to wait for you. Automatic jobs are de-duplicated for 30 minutes and limited to 20 per hour (`NL_MAX_AUTO_JOBS_PER_HOUR`).
