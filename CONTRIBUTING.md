# Contributing

1. Create a focused branch.
2. Keep changes inside the plugin runtime boundaries: `client/`, `server/`, and `shared/`.
3. Run `npm run typecheck`, `npm test`, and `npm pack --dry-run --ignore-scripts`.
4. Describe provider, filesystem, network, and permission effects in the pull request.

Do not commit provider credentials, plugin settings, model caches, generated `dist/` output, or project notebooks.
