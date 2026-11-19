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

These are selection guidelines, not additional capabilities or authorization. Use only the available tools and configured environments; the current implementation-workspace tool does not provide an enforced read-only mode. Existing authorization, model-routing, worker, integration, publication, and cleanup boundaries still apply.
