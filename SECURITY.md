# Security policy

## Scope

Overmind is a trusted Paseo plugin. Its daemon process runs with the permissions of the Paseo daemon user and can launch configured provider processes. Report issues that could expose credentials, cross workspace boundaries, bypass role ownership, or send project data to an unintended service.

## Reporting

Please do not open a public issue for an unpatched security vulnerability. Contact the repository owner through the private GitHub security advisory flow with:

- the affected version and Paseo version;
- a minimal reproduction;
- the expected and observed authority boundary; and
- any logs with credentials and project data removed.

The optional JEV integration is an external data path and is disabled by default. Confirm it is disabled before sharing a diagnostic bundle.
