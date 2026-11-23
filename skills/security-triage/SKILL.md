---
name: security-triage
description: How to triage a neural-link security incident (prompt injection, secret exposure, malicious email, spoofable domain) and what to do next.
---
# Security incident triage

1. Read the incident and its events (Security → Threat response, or `nl security incidents`). Note the rule that opened it, the actor and the first event time.
2. Classify:
   - **Prompt injection**: check which tool result carried it (event `source`). If the mode was `monitor`, assume the model may have followed it: review that agent's tool calls after the event time in the governance archive (`kind: llm_call`, actor = the agent).
   - **Secret exposure** (`secret` logged, or `output_leak`): treat the value as compromised. Rotate it at the provider, update `.env`, then confirm with a new security scan.
   - **Malicious email**: block the sender domain at the mail gateway, search the archive for the same sender or link host, warn recipients.
   - **Spoofable domain**: follow the dmarc-rollout skill.
   - **Hidden agent**: open the file, decide register or delete.
3. Contain: restrict the actor in Security → Behavior if it is still producing events.
4. Record what you did as the resolution note, then resolve the incident.

Never paste secret values into chat, tickets or incident notes; reference them by environment variable name.
