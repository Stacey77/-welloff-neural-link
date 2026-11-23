---
name: dmarc-rollout
description: Safe step-by-step plan to move a domain from no DMARC to p=reject without blocking legitimate mail.
---
# DMARC rollout

1. **Inventory senders**: list every service that sends as the domain (Google Workspace or Microsoft 365, CRM, invoicing, marketing, helpdesk).
2. **SPF**: one `v=spf1` record that includes each sender, ending in `~all`. Keep it at 10 DNS lookups or fewer (`nl dmarc <domain>` reports the count).
3. **DKIM**: turn on DKIM signing in each sending service and publish its selector record.
4. **Monitor**: publish `v=DMARC1; p=none; rua=mailto:dmarc@<domain>; adkim=s; aspf=s`. Wait 2–4 weeks.
5. **Review reports**: upload aggregate XML reports in Security → DMARC. Every legitimate source must pass SPF or DKIM alignment. Fix the ones that fail.
6. **Enforce gradually**: `p=quarantine; pct=25`, then 50, then 100, then `p=reject`. Keep watching reports at each step.
7. **Parked domains** that never send: `v=spf1 -all` and `v=DMARC1; p=reject`.
