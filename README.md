# ormus-invoicer

> Self-hosted invoicing for solo operators and small studios. Express + SQLite + PDF. No SaaS, no monthly fee, no telemetry, no lock-in.

A minimal-but-complete invoicing tool you run yourself. Clients, invoices, line items, deals, status tracking, PDF export, shareable deal links. SQLite-backed, single binary's worth of dependencies, deploys anywhere Node runs.

## Why

Every invoicing SaaS is either expensive, locked-in, or too feature-heavy for solo operators. The minimum viable invoicer is:

1. CRUD for clients
2. CRUD for invoices with line items
3. Status (draft / sent / paid / overdue / cancelled)
4. PDF generation
5. Maybe deals / quotes with shareable links

That's the entire scope of `ormus-invoicer`. ~900 lines of `server.js`, one HTML file for the UI, one SQLite file for the data.

## Install

```bash
git clone https://github.com/HermeticOrmus/ormus-invoicer
cd ormus-invoicer
npm install
npm start
```

Open `http://localhost:8093`. The DB seeds itself on first run.

To configure your company name, logo, address, etc., edit settings via the UI (or directly in the SQLite `settings` table).

## Configuration

Environment variables (all optional):

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8093` | HTTP port |
| `DB_PATH` | `./data/invoicer.db` | SQLite file location |

Anything more (company name, logo, terms, etc.) lives in the `settings` table and is set via the UI.

## Schema

| Table | Purpose |
|---|---|
| `settings` | Key-value store for company name, address, branding, defaults |
| `clients` | Customer records (name, company, email, phone, address) |
| `invoices` | Invoice records with status, dates, totals, currency |
| `invoice_items` | Line items per invoice |
| `deals` | Quotes / proposals with shareable tokens (lifecycle: active → won/lost/archived) |

Foreign keys enforced. Cascading deletes on invoice items.

## Features

- **Invoices**: status lifecycle, multi-currency, tax rate, line items, due-date tracking
- **PDF export**: server-side via `pdfkit`, branded with your company info
- **Deals / quotes**: separate from invoices, with shareable public tokens
- **Status tracking**: draft / sent / paid / overdue / cancelled with timestamps for `paid_at` and `sent_at`
- **No external services**: no Stripe, no Mailchimp, no anything. Just data.

If you want to add Stripe payment links, email sending, or recurring invoices, fork it. The codebase is small enough to extend in an afternoon.

## Pairs with

Part of the **ormus session lifecycle** family — composable Claude Code skills:

- [ormus-handoff](https://github.com/HermeticOrmus/ormus-handoff) — capture session state before context limits
- [ormus-pickup](https://github.com/HermeticOrmus/ormus-pickup) — restore session context
- [ormus-absorb](https://github.com/HermeticOrmus/ormus-absorb) — distill conversation knowledge into persistent memory
- [ormus-explore](https://github.com/HermeticOrmus/ormus-explore) — token-efficient AST-based code search
- [ormus-vibe-proof](https://github.com/HermeticOrmus/ormus-vibe-proof) — security hardening for vibe-coded full-stack apps
- [ormus-meta-prompting](https://github.com/HermeticOrmus/ormus-meta-prompting) — categorical foundations for AI prompt engineering

## License

MIT. See [LICENSE](LICENSE).

## Origin

Built because the alternatives were either $30/mo SaaS with telemetry, or feature-bloated open source with too many configuration knobs. The minimum viable invoicer turns out to be ~900 lines of server.js and one HTML file. Released so other solo operators don't have to build the same thing again.

---

## Part of the Libre Open-Source Stack for Claude Code

This repository is part of a growing family of open-source toolkits for Claude Code.

### Libre suite — comprehensive plugin bundles

- [LibreUIUX-Claude-Code](https://github.com/HermeticOrmus/LibreUIUX-Claude-Code) — UI/UX development (152 agents, 70 plugins, 76 commands, 74 skills)
- [LibreArch-Claude-Code](https://github.com/HermeticOrmus/LibreArch-Claude-Code) — Software architecture and system design
- [LibreCopy-Claude-Code](https://github.com/HermeticOrmus/LibreCopy-Claude-Code) — Technical writing and documentation engineering
- [LibreDevOps-Claude-Code](https://github.com/HermeticOrmus/LibreDevOps-Claude-Code) — DevOps engineering and infrastructure automation
- [LibreEmbed-Claude-Code](https://github.com/HermeticOrmus/LibreEmbed-Claude-Code) — Embedded systems, firmware, and IoT development
- [LibreFinTech-Claude-Code](https://github.com/HermeticOrmus/LibreFinTech-Claude-Code) — Financial technology development
- [LibreGEO-Claude-Code](https://github.com/HermeticOrmus/LibreGEO-Claude-Code) — AI-search optimization (ChatGPT, Perplexity, Gemini, Google AI Overviews)
- [LibreGameDev-Claude-Code](https://github.com/HermeticOrmus/LibreGameDev-Claude-Code) — Game development across Godot, Unity, Unreal
- [LibreMLOps-Claude-Code](https://github.com/HermeticOrmus/LibreMLOps-Claude-Code) — ML engineering and AI operations
- [LibreMobileDev-Claude-Code](https://github.com/HermeticOrmus/LibreMobileDev-Claude-Code) — Mobile app development (Flutter, React Native, native iOS, native Android)
- [LibreSecOps-Claude-Code](https://github.com/HermeticOrmus/LibreSecOps-Claude-Code) — Security operations

### Skills mini-repos — single CLAUDE.md drop-ins

- [vibe-engineer-skills](https://github.com/HermeticOrmus/vibe-engineer-skills) — Direct AI codegen well (hypothesis → scope → validate → reject working-but-wrong)
- [markdown-discipline-skills](https://github.com/HermeticOrmus/markdown-discipline-skills) — Strip AI-slop from markdown (no em dashes, no marketing fluff)
- [shell-safety-skills](https://github.com/HermeticOrmus/shell-safety-skills) — `set -euo pipefail` discipline + 15 failure-mode examples
- [commit-standard-skills](https://github.com/HermeticOrmus/commit-standard-skills) — Ormus Commit Standard v1.0 + commit-msg hook + commitlint
- [unwoke-skills](https://github.com/HermeticOrmus/unwoke-skills) — Strip AI theater (ten sins to eliminate, symmetric engagement)
- [python-conventions-skills](https://github.com/HermeticOrmus/python-conventions-skills) — Modern Python 3.11+ (types, pathlib, async, ruff, mypy, uv)
- [typescript-conventions-skills](https://github.com/HermeticOrmus/typescript-conventions-skills) — TypeScript strict mode, discriminated unions, Result types
- [hermetic-laws-skills](https://github.com/HermeticOrmus/hermetic-laws-skills) — Seven Hermetic Principles applied to engineering
- [riper-workflow-skills](https://github.com/HermeticOrmus/riper-workflow-skills) — Research / Innovate / Plan / Execute / Review systematic dev
- [six-day-cycle-skills](https://github.com/HermeticOrmus/six-day-cycle-skills) — Sustainable shipping cadence with mandatory rest
- [token-optimization-skills](https://github.com/HermeticOrmus/token-optimization-skills) — Claude Code token + context optimization
- [osint-skills](https://github.com/HermeticOrmus/osint-skills) — OSINT research methodology (multi-wave investigative spiral)
- [calcinate-skills](https://github.com/HermeticOrmus/calcinate-skills) — Stage 1 of the Magnum Opus (burn project bloat)
- [claude-md-overhaul-skills](https://github.com/HermeticOrmus/claude-md-overhaul-skills) — Audit CLAUDE.md and MEMORY.md against caps
- [session-handoff-skills](https://github.com/HermeticOrmus/session-handoff-skills) — Session handoff + pickup discipline
- [naming-skills](https://github.com/HermeticOrmus/naming-skills) — Product naming methodology (mine the brand's vocabulary)
- [magnum-opus-skills](https://github.com/HermeticOrmus/magnum-opus-skills) — Seven-stage alchemy applied to project transformation

### Template source

- [andrej-karpathy-skills](https://github.com/HermeticOrmus/andrej-karpathy-skills) — the canonical single-file CLAUDE.md pattern (fork of jiayuan_jy's original)

Star the family, not just one — that's how the suite stays coherent.
