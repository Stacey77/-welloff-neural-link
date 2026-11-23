---
name: neural-link-cli
description: Use the nl command-line tool to run neural-link agents, security checks and engineering plans from a shell, instead of an MCP server.
---
# nl CLI

Requires the server running (`npm run dev`). Set `NL_URL` if it is not on http://localhost:3001 and `NEURAL_API_KEY` if the server uses one. After `npm run build`, run `node dist/cli.js <command>` or `npx nl <command>`.

| Command | What it does |
| --- | --- |
| `nl agents` | List agents |
| `nl dispatch <AGENT> <command> [json]` | Run one agent command, e.g. `nl dispatch NATURA query '{"message":"..."}'` |
| `nl ask "<prompt>"` | MAESTRO routes the question to the best model |
| `nl tools "<query>"` | Search MCP tools without loading them all |
| `nl skills [name]` | List skills or print one |
| `nl security status` | Posture score and top findings |
| `nl security events` | Recent security events |
| `nl security incidents` | Threat-response incidents |
| `nl email <file>` | Analyze an .eml file (use `-` for stdin) |
| `nl dmarc <domain>` | DMARC, SPF and DKIM check |
| `nl archive "<query>"` | Search the governance archive |

Output is JSON when stdout is not a terminal, so pipe it to `jq`.
