# Development build and preview

This is a frontend-only static SPA. No database, API server, Replit account, or runtime secret is required to preview it. Google Fonts is an external browser dependency; fonts fall back when unavailable. The repository currently limits several native dependencies to Linux x64/glibc, matching server02.

## Reproducible build

The upstream `7cf1967` lockfile was a truncated fragment without the lockfile header/importers. The review branch regenerates it and pins pnpm 10.32.1. This resolves dependencies anew; it cannot establish the exact versions used in Replit.

Use a supported Node runtime compatible with Vite 7 (server02 currently has Node 22.22.1). From the repository root:

```sh
npx --yes pnpm@10.32.1 install --frozen-lockfile
PORT=4173 BASE_PATH=/ npx --yes pnpm@10.32.1 --filter @workspace/personal-finance run typecheck
PORT=4173 BASE_PATH=/ npx --yes pnpm@10.32.1 --filter @workspace/personal-finance run build
```

Output: `artifacts/personal-finance/dist/public`. Both environment variables are required even for build. Use `/` for a root deployment. Never put secrets into a frontend environment variable or static output.

For an interactive, temporary GUI review:

```sh
PORT=4173 BASE_PATH=/ node artifacts/personal-finance/node_modules/vite/bin/vite.js preview --config artifacts/personal-finance/vite.config.ts --host 127.0.0.1 --strictPort
```

Vite preview is for this development review; use a proper static web server for a durable application deployment, including SPA fallback for `/transactions`, `/budgets`, `/categories`, `/imports`, and `/settings`. Future `/api` paths must reach the backend and must never fall back to index.html.

## server02 ownership and access

The canonical repository is `/home/humanlayer/repos/finn-advisor`. Inspect it before fetching/changing branches; create a separate task worktree under `/home/humanlayer/workspaces/`. Run repository operations, dependency installation, builds, and preview as **humanlayer**. Do not deploy over the existing worktree or install the optional database scaffold merely to serve this GUI.

For a temporary review with no firewall changes, keep the server listener on `127.0.0.1:4173` and forward it from the workstation:

```sh
ssh -F ~/.ssh/config -N -L 4174:127.0.0.1:4173 dev
```

Then open `http://127.0.0.1:4174`. Stop the preview and tunnel to roll back. The explicit SSH config bypasses a currently misowned system SSH include on the workstation without editing system configuration.

On 2026-09-12 server02 was reachable and had no listener on 4173. Access as admin01 succeeded, but `sudo -n -u humanlayer` required interactive authentication. **No deployment or server-side build has been performed.** An authenticated administrator session or HumanLayer execution is needed to perform the above steps under the correct account. No new web firewall port has been opened.

After preview acceptance, HumanLayer should define the durable service, health endpoint, private LAN/Tailscale exposure, TLS, log handling, update/rollback, and reboot validation. Production remains gated.
