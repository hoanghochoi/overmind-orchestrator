# Changelog

## Unreleased

- Add `create_supervisor_wake`: a Supervisor-only action targeting its authenticated current agent, with `maxRuns: 1` and no new-agent, provider, or model options.
- Preapprove the dedicated wake tool when opening existing Codex Supervisor sessions on Paseo 0.14, including sessions using `approval_policy = "never"`.

## 0.1.0

- Initial public packaging of Overmind Orchestrator for Paseo.
- Supervisor, Lead, and Peer orchestration.
- Role-aware provider adapters, causal notebook, anomaly detection, and contract locks.
