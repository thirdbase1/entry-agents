# Entry Agents — Project History

## Why Entry Agents exists

Entry Agents did not start as a completely new agent framework built from scratch.

The original idea was **Entry**: an agentic AI product I wanted to use and build. The original Entry codebase became difficult to work with because of the number of errors and reliability problems, so I eventually stopped pushing that version forward.

Instead of abandoning the idea, I took **Vercel Labs' Open Agents** as the foundation and rebuilt the project around the Entry vision. The repository is not a simple rename or cosmetic fork: over time, the foundation was heavily modified as real production problems appeared.

The important part of the history is the engineering loop:

```text
Entry vision
    ↓
Original Entry implementation
    ↓
Too many errors / reliability problems
    ↓
Vercel Open Agents foundation
    ↓
Entry Agents rebuild
    ↓
Real deployment problems
    ↓
Infrastructure, sandbox, security, model and workflow engineering
    ↓
Entry Gateway
```

## Entry Agents became the main focus

After switching to the Open Agents foundation, I focused heavily on turning it into the agent system I originally wanted Entry to be.

The work expanded far beyond the initial reference architecture. The system evolved around:

- Durable agent workflows
- Isolated Vercel sandboxes
- Sandbox snapshots and resume
- Sandbox migration and recovery
- Dead/stale snapshot handling
- Sandbox-name collision handling
- Workspace-bound shell execution
- Git and GitHub workflows
- Credential brokering and isolation
- MCP infrastructure
- Composio integration
- Model/provider configuration
- Context-window correctness
- Automatic context compaction
- Prompt/cache accounting
- Model pricing and credit estimation
- Cancellation and reconnect behavior
- Dev-server lifecycle handling
- Security hardening
- SSRF protection
- Rate limiting
- Regression tests for production failures

A major theme of the project has been solving failures discovered from actual runtime behavior rather than treating the initial architecture as fixed.

### Sandbox lifecycle

The sandbox system became one of the deepest areas of engineering work. Vercel sandboxes are not treated as the agent itself; the agent/workflow remains the control plane while the sandbox provides isolated execution.

The project evolved to handle cases such as:

- Sandboxes reaching their lifetime limit
- Non-persistent sandbox expiration
- Snapshot restoration failures
- Dead snapshots
- Stale snapshot IDs
- HTTP 410/404 resume failures
- Named-sandbox collisions
- Provisioning deadlocks
- Snapshot quota pressure
- Migration failures
- Relaunching development servers after migration
- Preserving a workspace while moving execution to a fresh sandbox

This led to the sandbox migration/recovery architecture: provision a fresh sandbox, preserve the workspace/state, restore it, update the session's active sandbox, and continue execution with as little user-visible disruption as possible.

## Why Entry Gateway exists

**Entry Gateway was born from the needs of Entry Agents.**

As Entry Agents became more serious, model infrastructure became its own problem. The agent needed to work across multiple providers and protocols while dealing with model availability, routing, pricing, fallbacks, caching, observability and reliability.

Rather than keep all of that complexity inside Entry Agents, I built **Entry Gateway** as the infrastructure layer needed by the agent system.

The relationship is therefore intentional:

```text
Entry Agents
     │
     │ needs reliable multi-provider model infrastructure
     ▼
Entry Gateway
     │
     ├── Native protocol routing
     ├── Model discovery
     ├── Provider fallback
     ├── Circuit breakers
     ├── Pricing / cost tracking
     ├── Prompt/cache accounting
     ├── Metrics and observability
     ├── Rate limiting
     └── Security / admin controls
```

Gateway can operate as an independent product, but its origin is directly connected to the problems encountered while building Entry Agents.

The two projects therefore form a feedback loop rather than a simple dependency:

```text
Build Entry Agents
       ↓
Discover infrastructure problem
       ↓
Build/fix Gateway
       ↓
Expose better routing/pricing/reliability
       ↓
Use it from Entry Agents
       ↓
Discover the next problem
       ↺
```

## What the commit history represents

The commit history is important context for understanding the project. It is not just a record of feature additions; much of it records production-driven engineering and architectural iteration.

Examples include fixes and improvements around:

- Workflow reliability and streaming
- Stop/cancellation races
- Message hangs
- Authentication/DB/workflow startup timeouts
- Model catalog loading and startup latency
- Snapshot restoration
- Sandbox reprovisioning
- Credential injection
- Git state
- Workspace security boundaries
- Provider/model context windows
- Cache billing
- Model pricing
- Gateway fallbacks
- Security audits and hardening
- PostgreSQL-backed metrics after cache-provider throttling

Many fixes were followed by regression tests or architectural changes so that the same failure mode would not simply return later.

## The lineage

It is useful to distinguish the three projects:

### Entry

The original product vision and earlier implementation. It was an ambitious agentic AI platform, but the implementation accumulated too many errors and became difficult to continue developing effectively.

### Entry Agents

The focused rebuild. Vercel Open Agents provided the starting point, but the project became heavily adapted around the Entry vision and the problems encountered while operating a real coding-agent system.

### Entry Gateway

Infrastructure created because Entry Agents needed a robust model gateway. It grew into a standalone native-protocol AI gateway with routing, failover, observability, pricing, caching, circuit breakers and security controls.

## The honest origin story

The goal of this project was never to claim that every original architectural idea was invented from nothing.

The Open Agents foundation gave the project a strong starting point. The engineering work that followed was about taking that foundation, pushing it into real use, finding where it broke, and repeatedly redesigning the surrounding systems until it could support the product vision.

That is the story behind Entry Agents:

> **A product vision that did not work in its first implementation, rebuilt on a stronger foundation, then pushed far enough that new infrastructure had to be created around it.**

Entry Gateway is one of the clearest examples of that evolution.
