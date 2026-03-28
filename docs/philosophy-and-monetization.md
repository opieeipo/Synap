# Synap: Product Philosophy & Monetization Strategy

## Core Philosophy

Synap is built to be **deployment-agnostic by design**. Every architectural decision prioritizes portability — zero-dependency frontend, pluggable backends, environment-aware adapters. The same core product runs as a hosted SaaS or as a self-contained package dropped into a customer's own infrastructure.

This isn't accidental. The organizations that need qualitative research tooling the most — government agencies, defense contractors, regulated industries — are often the ones least able to adopt SaaS products due to data sovereignty, compliance, and security requirements.

We build for both worlds from day one.

## Deployment Models

### Public SaaS (Primary Revenue Source)

The hosted, managed version of Synap. Researchers sign up, configure interview guides, and run studies without touching infrastructure.

- **Stack**: Supabase (auth, database, edge functions) + Azure OpenAI
- **Audience**: Academic researchers, commercial UX teams, consulting firms
- **Monetization**: Subscription-based (tiered by usage, features, or seats)

### Government / Internal Deployment (Market Presence Play)

A deployable package that drops into an organization's existing authorized environment (Azure Government, AWS GovCloud, on-prem, etc.). The application inherits the host environment's security controls and goes through the customer's internal software approval process — not the FedRAMP marketplace.

- **Stack**: Self-hosted Postgres + customer's AI provider (Azure OpenAI Service in Gov, AWS Bedrock, or local models)
- **Audience**: Federal agencies, defense/intel contractors, FedRAMP-bound organizations
- **Monetization**: None for now. This is a foot-in-the-door strategy to prove value in the government space and gather requirements from real deployments.
- **Delivery**: Deployable package (ARM template, Terraform module, Helm chart, or forkable repository) with deployment support documentation.

### Why Not FedRAMP Now?

Getting Synap itself FedRAMP-authorized is expensive, slow, and bureaucratic. It's the wrong move for an early-stage product. By deploying *inside* already-authorized environments, we sidestep that entirely while still serving government customers.

## Long-Term Convergence

If sufficient demand materializes in the government space, the path forward is:

1. **Validate demand** through internal deployments and user feedback
2. **Converge infrastructure learnings** from both the public SaaS and government deployment tracks
3. **Pursue FedRAMP SaaS authorization** — leveraging battle-tested architecture that already works in both contexts

The goal is to let the market pull us toward FedRAMP certification rather than pushing prematurely.

## Guiding Principles

- **SaaS-first for revenue.** The public product funds development.
- **Gov-ready by architecture.** Don't bolt on portability later — build it in now.
- **No premature bureaucracy.** Serve government customers through their existing infrastructure, not through certification theater.
- **Let demand lead.** The gov deployment option proves the market before we invest in formal authorization.
