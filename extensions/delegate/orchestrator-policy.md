# When to use subagents

Use subagents when the expected benefits outweigh the costs of briefing, execution, coordination, integration, and verification.

Do not assume more agents produce better results. Use the fewest agents needed to obtain the expected benefit. Additional agents can introduce coordination overhead, duplicate work, and propagate errors; each delegation should have a distinct purpose.

Good reasons to delegate include:

- **Focused summarization:** Read and understand many files or sources when the main agent only needs a focused, evidence-backed summary.
- **Better model fit:** Assign a subtask to a model better suited to its requirements.
- **Parallel progress:** Execute separable tasks concurrently when dependencies, shared interfaces, and ownership are sufficiently clear.
- **Context isolation:** Keep extensive task-specific instructions, language best practices, or framework guidance out of the main conversation when they apply only to a bounded subtask.
- **Independent examination:** Obtain a fresh review, investigate an alternative explanation, or challenge an approach when the potential quality improvement justifies the cost.

Before delegating, check that:

- The task has a clear boundary and expected output.
- It can proceed without excessive back-and-forth or shared-state conflicts.
- The main agent can meaningfully verify the result.
- Delegation offers an advantage over simply doing the work in the main agent.

Prefer keeping small, tightly coupled, or inherently sequential tasks in the main agent. A large prompt alone is not sufficient reason to delegate.

For independent assessments, prefer agents forming their own findings before comparing conclusions. Agent agreement is not proof of correctness.

The main agent remains responsible for reviewing results and integrating them. Summaries should include relevant source references and uncertainties; implementations should include reviewable changes and verification evidence. Independent subagent review does not replace the main agent's own review.

# Choosing a model and thinking level

Choose model capability and thinking effort separately. Base the choice on unresolved decisions, reasoning difficulty, and the consequences of mistakes, not merely file count or prompt length. Prefer the least costly suitable route considering latency, review and correction effort, not just token prices.

Use this provisional starting hierarchy, not a claim of universal benchmark superiority:

| Work | Model family or capability | Thinking |
| --- | --- | --- |
| Architecture/design review, ambiguous requirements, security or concurrency analysis | Opus; Sol is another candidate | High |
| Complex implementation with significant decisions remaining | Opus or Sol | Medium to high |
| Ordinary features following established patterns | Sonnet or a suitable mid-tier coding model | Medium |
| Clearly specified implementation with interfaces and decisions settled | Mid-tier model or a validated cheaper model | Low |
| Narrow mechanical transformations with strong independent checks | Validated small/local model | Lowest supported and tested setting |

Lower thinking does not require a smaller model. A capable model at low effort may be preferable to a smaller model thinking longer. Settled design decisions do not remove implementation difficulty: subtle algorithms, concurrency, security and difficult-to-detect failures still warrant sufficient capability and reasoning. Reserve extra-high/maximum effort for a specific expected benefit rather than using it by default.

Discover exact routes through delegate_models; family names above are preferences, not executable IDs. Select an explicit model and thinking level supported by that route and operator policy. Catalogue presence does not establish worker authentication or readiness. Respect data-access/provider restrictions and existing backend routing. Local models remain limited to validated mechanical slices; a medium-only policy must not be overridden to request low thinking. If no suitable route is available, report the blocker rather than guessing, silently substituting, retrying or escalating to a paid model.

Keep each launch on its explicitly selected route. Do not use an automatic router, including Jev, to bypass fixed-route, backend, effort or authorization boundaries. Jev integration is deferred; any future advisory selector needs separate evaluation and integration, not implicit activation by this policy.

Revisit the hierarchy using representative tasks in the actual worker harness: accepted-result quality, tool/instruction failures, main-agent review/correction effort, and time/cost per accepted result. Generic benchmarks inform candidates but do not establish the best model for our repositories.

# Preparing the launch prompt

Build the launch prompt from three layers: launcher-supplied shared worker rules, relevant repository/specialist guidance, and an invoker-written task brief. Use the existing brief text field, not a new tool argument. The delegate does not inherit the main conversation; include the necessary facts and decisions without copying the whole transcript or repeating the worker policy.

Use this adaptable Markdown template for both initial tasks and fresh follow-ups:

```markdown
## Goal
Required outcome and why it matters.
## Scope and exclusions
Owned files/areas, non-goals, dependencies and agreed shared interfaces.
## Relevant context
Necessary facts, assumptions and source references.
## Settled decisions
Decisions to preserve; do not reopen them incidentally.
## Open decisions
Questions to resolve, permitted discretion and conditions requiring a blocker report.
## Guidance to read
Repository instructions and relevant language/framework/specialist guidance, with paths.
## Acceptance criteria and verification
Observable success conditions, planned check indices/targets and any known verification gaps.
## Expected report
Changes or findings, source/check evidence, uncertainties, blockers and remaining review risks.
```

Scale the detail to the task; combine or omit inapplicable sections rather than filling boilerplate. Give precise steps for mechanical work and clear questions without predetermined conclusions for investigations. Separate established facts from hypotheses. State the requested work type, including whether changes are permitted; a no-edit instruction is not an enforced read-only environment.

The delegate reads referenced guidance in its own environment. Select relevant guidance as needed; do not invent named profiles or assume parent-only files are available. Verify references will be accessible from the workspace, or provide the necessary secret-free excerpts. Repository instructions and shared worker rules still apply; conflicts or missing required guidance are blockers, not permission to bypass them.

Model, thinking, configured environment profile and executable checks remain separate tool arguments. The brief explains verification expectations but must agree with the actual check plan; follow-ups use the workspace's frozen checks/profile. Missing formatting, codegen or test commands must be planned by the parent, not improvised outside worker tools. A fresh follow-up must restate relevant prior findings, current state and remaining work rather than assuming the previous worker's conversation is available.

These are selection guidelines, not additional capabilities or authorization. Use only the available tools and configured environments; the current implementation-workspace tool does not provide an enforced read-only mode. Existing authorization, model-routing, worker, integration, publication, and cleanup boundaries still apply.
