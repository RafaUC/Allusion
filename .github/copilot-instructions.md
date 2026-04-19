# Project Guidelines

## Build and Test
- Install dependencies: `yarn install`
- Development workflow (two terminals):
  - `yarn dev` (webpack watch build)
  - `yarn start` (launch Electron)
- Run tests: `yarn test`
- Lint and auto-fix: `yarn lint`
- Production build: `yarn build`
- Package app installers: `yarn package`
- WASM builds when touching Rust/WASM code:
  - `yarn build:masonry`
  - `yarn build:exr`

## Architecture
- This is an Electron app with a clear process boundary:
  - Main process entry: `src/main.ts`
  - Renderer entry: `src/renderer.tsx`
  - IPC contracts and handlers: `src/ipc/messages.ts`, `src/ipc/main.ts`, `src/ipc/renderer.ts`
- Data storage is handled through the internal backend layer in `src/backend/` (SQLite + Kysely).
- Frontend state is MobX-based (`src/frontend/stores/`) and domain entities live in `src/frontend/entities/`.
- Shared UI widgets are in `widgets/`; generic utilities are in `common/`.

## Code Style and Conventions
- Follow TypeScript strict mode and existing path aliases in `tsconfig.json` (`src/*`, `widgets/*`, `resources/*`).
- Follow formatting and linting rules from `.prettierrc.json` and `.eslintrc.json`.
- For files under `src/backend/*.ts`, `src/frontend/entities/*.ts`, and `src/frontend/stores/*.ts`, explicit module boundary types are required by ESLint overrides.
- For React + MobX UI, wrap components that consume observable state with `observer(...)`.

## Project-Specific Pitfalls
- Native dependencies are used (for example `better-sqlite3`), so keep `yarn install`/postinstall rebuild behavior intact.
- If you add a DB migration, register it in `src/backend/config.ts` (`InlineMigrationProvider#getMigrations`).
- Jest uses `fake-indexeddb/auto` and `tests/setup/jest.crypto.js`; tests run in Node, not a full Electron runtime.
- When changing WASM crates or wasm-bindgen versions, keep the `wasm/README.md` caveats in mind.

## Existing Docs (Link, Don’t Duplicate)
- Root development and release flow: `README.md`
- Backend design notes: `src/backend/README.md`
- MobX store guidance: `src/frontend/stores/README.MD`
- Entity/domain-object behavior: `src/frontend/entities/README.MD`
- WASM toolchain and caveats: `wasm/README.md`
- Web clipper architecture: `src/clipper/README.md`
