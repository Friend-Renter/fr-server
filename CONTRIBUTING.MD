# Contributing Guide

## Branching
- Create feature branches off `main`.
- Suggested prefixes: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`.

## Commits (Conventional Commits)
- `feat: add booking locks`
- `fix(auth): refresh token rotation bug`
- `chore(c0): add repo hygiene files`

## Pull Requests
- PRs into `main`. Linear history (squash or rebase).
- Ensure CI checks pass (lint/test once enabled).
- Include a brief description of changes and testing steps.

## Local Dev (after Step 2+)
- Node 18 (see `.nvmrc`), npm
- Do not commit secrets or large binaries
- Run `npm run lint` and `npm test` before pushing (after scripts exist)

## Code Style
- TypeScript strict
- ESM modules
- Zod for input validation
- Money in cents; UTC times only
