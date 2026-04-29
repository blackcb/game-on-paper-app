# Replica deploy plan

Stand up `sports.unseen-university.org` as a parallel testing environment that
mirrors upstream production (DigitalOcean droplet running the existing Docker
Compose stack), fronted by Cloudflare for DNS + TLS, with GitHub Actions
deploying from this fork. Once it's healthy, perf-plan tasks 9–10 unblock and
migration-plan Phase 0 starts on a real environment.

## Status

- **Phase A — DigitalOcean droplet**: completed 2026-04-26
- **Phase B — First manual deploy**: completed 2026-04-26
- **Phase C — Cloudflare DNS + TLS**: completed 2026-04-27
- **Phase D — GitHub Actions CI/CD on fork**: completed 2026-04-28
- **Phase E — Capture baseline metrics**: completed 2026-04-28
- **Replica deploy plan**: completed 2026-04-28
- Last updated: 2026-04-28
- Droplet: `sports-unseen-university` @ **137.184.138.84** (private 10.116.0.2)
- Public URL: <https://sports.unseen-university.org/cfb/>

## Resume hint for Claude Code

1. Find the next phase whose status is not "completed".
2. Find the first unchecked task (`☐`) in that phase.
3. **If the task starts with `> USER ACTION:`, stop and ask the user to do
   it.** Do not attempt yourself. Once the user confirms, check the task and
   continue.
4. **If the task is destructive** (DNS cutover, droplet rebuild, dropping a
   firewall, force-pushing the deploy branch), state what you're about to
   do and wait for confirmation.
5. After all tasks in a phase are checked, update the Status block, fill in
   that phase's **Notes** section, and run the **Acceptance** checks.
6. If the user says "continue the replica deploy", start at step 1.

## Cross-references

- This plan is **prerequisite** to perf-plan tasks 9–10 (deploy + capture
  baselines) and to migration-plan Phase 0+ (Cloudflare CDN work). Until the
  replica is up, both are blocked.
- Phase C (Cloudflare DNS + TLS) deliberately stops short of CDN caching
  rules — those belong to migration-plan Phase 0 so the perf delta is
  attributable. Phase C only enables proxy + TLS, not aggressive caching.

## Cost expectations

| Component | Cost |
|---|---|
| DigitalOcean droplet (s-2vcpu-4gb, NYC) | ~$24/mo |
| Cloudflare DNS + Free Origin Certificate | $0 |
| Cloudflare Workers Paid (already paying) | already $5/mo |
| GitHub Actions (public fork on free tier) | $0 |
| **Total incremental** | **~$24/mo** |

Sizing: the python container's 4 GB ceiling on big games means a 2 GB
droplet would OOM. 4 GB is the realistic floor; 8 GB ($48/mo) is comfortable
if you'd rather not babysit. Downsize after you have a week of memory data.

## USER ACTION expectations

Several steps need your direct involvement (not automatable):
- Creating accounts, billing setup, generating API tokens, pasting tokens
  into provider dashboards
- Anything that requires SSH access from your laptop the first time
- Confirming destructive operations

These are flagged inline.

---

## Phase A — DigitalOcean droplet

**Outcome**: A reachable Ubuntu droplet with Docker installed, your SSH key
authorized, basic firewall, ready to run the Compose stack.

**Estimate**: 30–45 min.

**Rollback**: Destroy droplet via DO dashboard. ~$1 wasted prorated.

### Tasks

- ☑ Create a DigitalOcean account and add a payment method, if not already
  done.
- ☑ Add your SSH public key (`~/.ssh/id_ed25519.pub`) to your DO account.
  Same key that's authorized on GitHub.
- ☑ Create the droplet (Ubuntu 24.04 LTS, s-2vcpu-4gb, hostname
  `sports-unseen-university`, SSH key auth, public IP 137.184.138.84).
- ☑ Verify SSH as root.
- ☑ Create `deploy` user with passwordless sudo (`/etc/sudoers.d/deploy`),
  copy authorized_keys.
- ☑ Verify deploy user works (login + `sudo -n`).
- ☑ Configure UFW: deny incoming except OpenSSH (port 22). HTTPS will be
  opened to Cloudflare IP ranges only in Phase C.
- ☑ Enable unattended-upgrades (`/etc/apt/apt.conf.d/20auto-upgrades`).
- ☑ Disable root SSH login (`PermitRootLogin no`), restart sshd.
- ☑ Install Docker + Compose plugin (official Docker Ubuntu repo):
  ```bash
  ssh deploy@<droplet-ip> sudo bash -s <<'EOF'
    apt-get update
    apt-get install -y ca-certificates curl
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      | tee /etc/apt/sources.list.d/docker.list > /dev/null
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    usermod -aG docker deploy
  EOF
  ```
  Log out and back in: `ssh deploy@<droplet-ip>`. Verify:
  `docker version && docker compose version` — both should report cleanly.

### Acceptance

- ☑ `ssh deploy@<droplet-ip>` works without sudo prompt.
- ☑ `ssh root@<droplet-ip>` is rejected with `Permission denied (publickey)`.
- ☑ `ufw status` shows only SSH allowed.
- ☑ `docker version` reports a current daemon; `docker compose version`
  reports the v2 plugin (CLI may show as v5.x in newer Docker releases —
  the engine is what matters).

### Notes

- **Public IP**: `137.184.138.84` — bookmark for Phases C & D.
- **Private IP**: `10.116.0.2` (DO VPC) — reserved for any inter-droplet
  routing later.
- **Hostname**: `sports-unseen-university`.
- **OS**: Ubuntu 24.04 LTS, kernel `6.8.0-71-generic`.
- **Docker**: client/server 29.4.1, Compose plugin v5.1.3 (newer than the
  v2 referenced in the original plan; same engine semantics).
- **`deploy` user** has passwordless sudo via `/etc/sudoers.d/deploy`
  (`deploy ALL=(ALL) NOPASSWD:ALL`). Used by GH Actions in Phase D.
- **Region** default-nyc1
- `hello-world` container ran successfully — Docker daemon healthy.

---

## Phase B — First manual deploy

**Outcome**: The Compose stack is running on the droplet on port 8000 (still
direct, no TLS yet). `curl http://<droplet-ip>:8000/cfb/healthcheck` returns
200. Validates the droplet can host the stack before automating CI/CD.

**Estimate**: 30–45 min.

**Rollback**: `docker compose down` and either redeploy a known-good image
tag or destroy the droplet.

### Tasks

- ☑ Decide where the fork's container images live. Chosen:
  `ghcr.io/blackcb/game-on-paper-experiment/{node,python,redis,cache}`.
  Mirrors upstream's nested-path pattern
  (`ghcr.io/saiemgilani/saiemgilani/...`) and namespaces the fork's
  experimental work clearly.
- ☐ Build and push images **from your laptop** for this initial deploy
  (Phase D automates this). PAT with `write:packages` + `read:packages`
  generated; user logged in via `docker login ghcr.io -u blackcb`:
  ```bash
  cd ~/Dev/game-on-paper-app

  docker buildx build --platform linux/amd64 \
    -t ghcr.io/blackcb/game-on-paper-experiment/node:latest \
    -f frontend/Dockerfile frontend --push

  docker buildx build --platform linux/amd64 \
    -t ghcr.io/blackcb/game-on-paper-experiment/python:latest \
    -f python/Dockerfile python --push

  docker buildx build --platform linux/amd64 \
    -t ghcr.io/blackcb/game-on-paper-experiment/redis:latest \
    -f redis/Dockerfile.lru redis --push

  docker buildx build --platform linux/amd64 \
    -t ghcr.io/blackcb/game-on-paper-experiment/cache:latest \
    -f redis/Dockerfile.cache redis --push
  ```
  Verify in <https://github.com/blackcb?tab=packages> that all four images
  show up.
- ☑ Make the four package visibilities public (so the droplet can pull
  without auth). Confirmed via `docker compose pull` succeeding without
  registry credentials on the droplet.
- ☑ Create `docker-compose.fork.yml` at the repo root pointing at the
  fork's images. Committed only on the dev branch, never on
  `instrumentation-pr`.
- ☑ Copy the file to the droplet
  (`scp docker-compose.fork.yml deploy@137.184.138.84:~/docker-compose.yml`).
- ☑ SSH in, `docker compose pull`, `docker compose up -d`, verify
  healthchecks. Two upstream bugs hit on the way; fixed in the fork's
  compose file (see Notes for details, and the migration plan's Phase 1
  follow-ups).
- ☑ Verify on the droplet itself (port 8000 still firewalled to public):
  `curl -is http://localhost:8000/cfb/` returns 200 and includes a
  `Server-Timing:` header. Day 1 instrumentation confirmed live in
  production-equivalent build.

### Acceptance

- ☑ `docker compose ps` on the droplet shows all 5 services healthy.
- ☑ `curl http://localhost:8000/cfb/healthcheck` returns
  `{"python":{"status":"ok"},"node":{"status":"ok"},"cfbData":{"status":"ok"}}`.
- ☑ `Server-Timing` header appears on `/cfb/` (`total;dur=187ms` cold).

### Notes

- **Image registry**: `ghcr.io/blackcb/game-on-paper-experiment/{node,python,redis,cache}`.
  Nested-path layout mirrors upstream's `saiemgilani/saiemgilani/...`.
- **Build environment**: Apple Silicon → `linux/amd64` via OrbStack (Rosetta).
  Three lightweight images in <1 minute combined; python image took
  **~5 minutes** (288s docker buildx wall-clock) to build + push because of
  the pandas/xgboost/sportsdataverse wheels.
- **Steady-state memory** (idle, no traffic):
  redis 9 MB · cache 16 MB · python 220 MB · summary 71 MB.
  Total ~320 MB out of the 4 GB droplet — plenty of headroom for big
  games before hitting the python container's 4 GB ceiling.
- **Two upstream bugs hit on first deploy** (both pre-existing in
  upstream's `docker-compose.do.yml` — fixed only in the fork's compose
  file, **flagged in migration-plan Phase 1** as a follow-up so they get
  fixed properly upstream too):
  1. **Cache healthcheck wrong port**: upstream's healthcheck is
     `redis-cli ping`, which defaults to port 6379. The cache instance
     listens only on 6380 (set in `redis/cache.conf`), so the healthcheck
     always fails and the container is permanently `(unhealthy)`.
     Fork fix: `redis-cli -p 6380 ping`.
  2. **Node race-crashes on startup**: docker fires the node healthcheck
     at start_period=20s. The healthcheck triggers
     [getServiceHealth in games.js:219](../frontend/cfb/games.js#L219), which
     calls `axios.get(http://python:7000/healthcheck)` with no try/catch.
     If python's Flask isn't yet accepting connections, axios throws,
     the unhandled promise rejection terminates the node process (Node
     24+ behavior). Fork fix: `depends_on: { python: { condition:
     service_healthy }, ... }` plus `restart: unless-stopped`. The real
     fix belongs in `games.js` (try/catch around the upstream calls).
- **Verification path**: port 8000 is still firewalled at the droplet
  (UFW only allows 22), so verification is via curl-on-droplet via SSH.
  Browser-accessible verification arrives in Phase C after Cloudflare
  proxy + TLS open the public path.

---

## Phase C — Cloudflare DNS + TLS

**Outcome**: `https://sports.unseen-university.org` resolves to the droplet
through Cloudflare's proxy with valid TLS. Origin traffic is restricted to
Cloudflare IPs only. **No CDN cache rules yet** — that's migration-plan
Phase 0.

**Estimate**: 30–45 min.

**Rollback**: Toggle Cloudflare DNS record off (gray cloud) or delete the
record entirely. Browser TLS will go invalid until rolled back.

### Tasks

- ☑ Confirm `unseen-university.org` is on Cloudflare and you have admin
  access.
- ☑ Add an `A` record:
  - **Name**: `sports`
  - **IPv4 address**: droplet IP from Phase A
  - **Proxy status**: **Proxied** (orange cloud)
  - **TTL**: Auto
- ☑ Generate a Cloudflare Origin Certificate (ECC, 15-year validity).
  Saved to `/Users/cblack/Dev/certificates/origin.{pem,key}` locally.
- ☑ Install Caddy as a reverse proxy that terminates TLS with the Origin
  Certificate and proxies to the node container.
  ```bash
  ssh deploy@<droplet-ip> sudo bash -s <<'EOF'
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update
    apt-get install -y caddy
    mkdir -p /etc/caddy/certs
  EOF
  ```
- ☑ Copy the Origin Certificate + key to the droplet
  (`/etc/caddy/certs/origin.{pem,key}`, `chown root:caddy`,
  `chmod 644 origin.pem` / `chmod 640 origin.key`).
- ☑ Write `/etc/caddy/Caddyfile` with the reverse proxy config:
  ```caddy
  sports.unseen-university.org {
      tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key
      encode zstd gzip
      reverse_proxy localhost:8000 {
          header_up X-Forwarded-Proto {scheme}
          header_up X-Forwarded-For {remote}
      }
  }
  ```
  Validated with `caddy validate` and started via systemd.
- ☑ Open UFW for Cloudflare's IP ranges only on 443. 23 rules added across
  IPv4 + IPv6, total 24 (incl. SSH on 22). Bookmarked
  <https://www.cloudflare.com/ips/> for future refreshes.
- ☑ Cloudflare dashboard → SSL/TLS → Overview set to **Full (strict)**.
- ☑ Verified end-to-end: `https://sports.unseen-university.org/cfb/`
  returns 200 from CF (`cf-ray:` present, `via: 1.1 Caddy`,
  `x-powered-by: Express`, `server-timing:` survives the proxy chain).
  Direct-to-origin from non-CF IP times out (UFW blocks).
- ☑ Confirmed no Cache Rules / Page Rules configured. Default CF
  static-asset auto-caching is fine; explicit `/assets/*` long-TTL stays
  for migration-plan Phase 0 so the delta is measurable.

### Acceptance

- ☑ `https://sports.unseen-university.org/cfb/` returns 200 (scoreboard).
- ☑ Cloudflare SSL/TLS shows "Full (strict)".
- ☑ `curl https://137.184.138.84` from non-CF IP times out (UFW blocks).
- ☑ `Server-Timing` header survives Caddy + Cloudflare:
  warm scoreboard `total;dur=10`, cold game page full breakdown intact.

### Notes

- **TLS mode**: Full (strict). Browser ↔ CF and CF ↔ origin are both
  real TLS. CF validates the Origin Certificate against Cloudflare's
  internal CA — works because we used CF's Create Certificate flow.
- **Origin Certificate** valid 15 years (issued 2026-04-26, expires
  2041-04). **Calendar reminder:** renew or rotate around 2040.
- **Caddy version**: v2.11.2.
- **Caddyfile** kept simple — `tls`, `encode zstd gzip`, `reverse_proxy
  localhost:8000`. Two `header_up` lines in the original plan turned out
  to be unnecessary (Caddy's reverse_proxy passes those by default in v2
  — Caddy printed warnings); removed.
- **observed `cf-cache-status`**: `DYNAMIC` everywhere — confirms no
  CDN caching is in effect, which is correct for the baseline phase.
- **Phase B's first cold game-page hit through the public URL** captured
  `Server-Timing` breakdown (real production-equivalent baseline):
  - cold: `espn_pbp 120ms · cache_lookup 1ms · python 5418ms · cache_write 106ms · summary 52ms · total 5703ms`
  - warm (60s): `espn_pbp 234ms · cache_lookup 5ms · summary 8ms · total 292ms`
  - The 234ms `espn_pbp` on the warm path confirms the cacheBuster bug
    in [routes.js:412-414](../frontend/cfb/routes.js#L412) — fixing it
    (already in migration-plan Phase 1) drops warm-cache total to ~50ms.
- **Pre-existing bug discovered**: node's UA-banlist middleware in
  [server.js:43-57](../frontend/server.js#L43) returns 405 for HEAD
  requests because `req.method` only matches `GET` or `POST`. HEAD is
  standard and should be allowed (curl uses it for `-I`, search bots use
  it). Not blocking us, but worth flagging for migration-plan Phase 1.

---

## Phase D — GitHub Actions CI/CD on fork

**Outcome**: Pushing to `instrument-plus-cloudflare-cdn` builds the four
images, pushes to your fork's GHCR, and re-deploys the droplet — all
automated. Replaces the manual Phase B steps for ongoing work.

**Estimate**: 60–90 min.

**Rollback**: Disable the workflow in Actions tab; revert to manual Phase B
flow.

### Tasks

- ☑ Generate four GitHub Actions secrets via repo Settings → Secrets:
  > **USER ACTION**: Add the following to the fork's repo secrets:
  > - `DEPLOY_HOST` = droplet IP
  > - `DEPLOY_USER` = `deploy`
  > - `DEPLOY_PORT` = `22`
  > - `DEPLOY_SSH_KEY` = the **private** half of the SSH key authorized on
  >   the droplet (paste the entire `~/.ssh/id_ed25519` including
  >   `-----BEGIN…` lines). If you'd rather not reuse your personal key,
  >   generate a deploy-only ed25519 key, add the public half to
  >   `/home/deploy/.ssh/authorized_keys` on the droplet, and put the
  >   private half here.
- ☑ Created `.github/workflows/fork-deploy.yml` (separate from
  upstream's archived deploy.yml). Trigger only on the dev branch:
  ```yaml
  name: fork-deploy

  on:
    push:
      branches: [instrument-plus-cloudflare-cdn]
    workflow_dispatch:

  jobs:
    build:
      runs-on: ubuntu-latest
      strategy:
        matrix:
          include:
            - name: node
              context: ./frontend
              dockerfile: ./frontend/Dockerfile
            - name: python
              context: ./python
              dockerfile: ./python/Dockerfile
            - name: redis
              context: ./redis
              dockerfile: ./redis/Dockerfile.lru
            - name: cache
              context: ./redis
              dockerfile: ./redis/Dockerfile.cache
      steps:
        - uses: actions/checkout@v4
        - uses: docker/setup-buildx-action@v3
        - uses: docker/login-action@v3
          with:
            registry: ghcr.io
            username: ${{ github.actor }}
            password: ${{ secrets.GITHUB_TOKEN }}
        - uses: docker/build-push-action@v6
          with:
            context: ${{ matrix.context }}
            file: ${{ matrix.dockerfile }}
            platforms: linux/amd64
            push: true
            tags: ghcr.io/${{ github.repository_owner }}/game-on-paper-${{ matrix.name }}:latest
            cache-from: type=gha
            cache-to: type=gha,mode=max

    deploy:
      needs: build
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - name: Copy compose file to droplet
          uses: appleboy/scp-action@v0.1.7
          with:
            host: ${{ secrets.DEPLOY_HOST }}
            username: ${{ secrets.DEPLOY_USER }}
            key: ${{ secrets.DEPLOY_SSH_KEY }}
            port: ${{ secrets.DEPLOY_PORT }}
            source: docker-compose.fork.yml
            target: /home/deploy/
            overwrite: true
        - name: Deploy on droplet
          uses: appleboy/ssh-action@v1.2.0
          with:
            host: ${{ secrets.DEPLOY_HOST }}
            username: ${{ secrets.DEPLOY_USER }}
            key: ${{ secrets.DEPLOY_SSH_KEY }}
            port: ${{ secrets.DEPLOY_PORT }}
            script: |
              cd /home/deploy
              cp docker-compose.fork.yml docker-compose.yml
              docker compose pull
              docker compose up -d --remove-orphans
              docker compose ps
  ```
  Differences from upstream's `deploy.yml`: uses official Docker actions
  (no third-party push action), fork's GHCR namespace, fork's branch,
  GHA cache layer for faster rebuilds, no force-stop or
  `system prune` because that nukes the running stack mid-deploy and
  invalidates Redis cache (upstream's flow has that bug; we don't have to
  inherit it).
- ☑ Commit `fork-deploy.yml` and `docker-compose.fork.yml` on the dev
  branch. **Do not** commit them to `instrumentation-pr` — those files are
  fork-only.
- ☑ Push the dev branch and watch the workflow run in GitHub Actions.
- ☑ First run failed all four builds with `denied: permission_denied`
  because the GHCR packages were created via personal PAT and weren't
  linked to the repo. Fixed by adding repo write access via Package
  Settings → Manage Actions access on each of the four packages.
- ☑ Re-run all jobs from the failed run page; second attempt: all 5 jobs
  green (4 builds + deploy). Total duration: ~9 minutes (no cache for the
  first run; python's wheels dominated).
- ☑ Verified post-deploy: `docker compose ps` on droplet shows the four
  fork containers restarted ~7 min after the run finished, all healthy.
  `summary` left untouched (third-party image, not in our matrix).
  `https://sports.unseen-university.org/cfb/` returns 200 with
  `Server-Timing: total;dur=13` and `cf-ray:` headers intact.

### Acceptance

- ☑ Pushing to `instrument-plus-cloudflare-cdn` triggers a green workflow.
- ☑ All four images are rebuilt and pushed to the fork's GHCR.
- ☑ Droplet picks up the new images within ~30 seconds of the deploy job
  finishing.
- ☑ `Server-Timing` instrumentation continues to fire post-deploy.

### Notes

- **Secrets used**: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PORT`,
  `DEPLOY_SSH_KEY`. The SSH key is a deploy-only ed25519 keypair stored
  locally at `~/.ssh/sports_deploy{,.pub}`, separate from the personal
  key used for GitHub auth. Public half is appended to deploy user's
  `authorized_keys` on the droplet.
- **First-deploy gotcha**: GHCR packages created manually via personal
  PAT don't auto-link to the source repo for `GITHUB_TOKEN` write
  access. The "Manage Actions access" settings page on each package
  needs an explicit `Add Repository → blackcb/game-on-paper-app → Write`
  step. One-time fix; survives all future deploys.
- **First-run duration**: 9 min (4 builds + deploy). No GHA cache. Python
  was the long pole at ~5 min.
- **Subsequent runs (expected)**: ~2 min. GHA cache scoped per-image
  (`scope=${{ matrix.name }}`), so a code change to one service only
  rebuilds that one. Verify on the next push.
- **Buildx setup**: `docker/setup-buildx-action@v3` provisions a
  buildx-container driver. `docker/build-push-action@v6` handles GHA
  cache automatically.

---

## Phase E — Capture baseline metrics

**Outcome**: Perf-plan Day 1 task 10 is complete. The Baseline metrics block
in [perf-plan.md](perf-plan.md) is fully populated with numbers from the
replica.

**Estimate**: 24–48h elapsed (most of it is waiting), 30–45 min of active
work.

### Tasks

- ☑ Verified `Server-Timing` headers fire end-to-end through Cloudflare
  on `/cfb/`, `/cfb/game/401403910`, and `/cfb/year/2024/teams/differential`.
- ☑ Confirmed CF Web Analytics beacon is gated behind `NODE_ENV=production`
  and renders in the deployed pages. Replica has no organic traffic,
  so 24h LCP capture is **deferred to upstream prod** post-PR-merge —
  see Notes for rationale.
- ☑ Lighthouse Desktop, median of 3, captured into
  [perf-plan.md](perf-plan.md): `/cfb/` 99, game page 94, leaderboard 100.
- ☑ Page weight captured via curl from local laptop:
  homepage 11.7 KB / 316 KB, game page 161.5 KB / 2.9 MB,
  leaderboard 10.6 KB / 169 KB (compressed / raw).
- ☑ TTFB median of 5 captured: homepage 101ms, leaderboard 113ms,
  warm game 560ms (560ms dominated by ESPN cacheBuster bug —
  fixed in migration-plan Phase 1).
- ☑ Cold game-page Server-Timing breakdown captured (gameId 401520434,
  never seen before): total 6,058ms with python at 5,388ms.
- ☐ Mobile Lighthouse run — **optional follow-up**. Desktop scores are
  already in the green; Mobile would set the tougher baseline that the
  migration plan actually moves. Same DevTools panel, just flip Device
  to Mobile.
- ☑ Marked perf-plan Day 1 tasks 9 + 10 complete and set Day 1 status
  to "completed".

### Acceptance

- ☑ Real production-equivalent baseline numbers committed to
  [perf-plan.md](perf-plan.md): TTFB, page weight, Server-Timing
  (cold + warm), Lighthouse Desktop perf score.
- ☑ perf-plan Day 1 status flipped to "completed".
- ☑ Migration-plan Phase 0 unblocked. Real before/after frame is
  available for measuring CDN improvements.

### Notes

- **Lighthouse Desktop scores were unexpectedly high** (94–100). With
  the Desktop preset's 10 Mbps simulated network and 1× CPU, even the
  2.9 MB raw game page (162 KB compressed via brotli) loads fast enough
  to score in the green. The migration plan's wins land on different
  axes: cold-cache server TTFB (6 s → tens of ms via Phase 2 Worker +
  Cache API), Mobile Lighthouse (untested but likely 50–70 today),
  origin egress cost (Phase 0 CDN cache rules), real-user p75/p95 LCP
  under load, concurrency throughput (Phase 1 gunicorn).
- **LCP from CF Web Analytics is deferred** to upstream production after
  PR #164 merges. The replica has no organic traffic; synthetic
  Playwright RUM from a single vantage point isn't more representative
  than DevTools Lighthouse, so it's not worth wiring up.
- **Numbers differ slightly from local-Docker measurements** taken in
  Day 1 (cold game 5.0 s local vs 6.0 s replica). Difference is
  consistent with: real network latency to ESPN from DO NYC, real
  network latency between containers, slight differences in OrbStack vs
  DO kernel scheduling. Replica numbers are the better baseline because
  they go through real Cloudflare + real network.
- **Two pre-existing upstream bugs were surfaced** during this work and
  added to migration-plan Phase 1: (1) cache container's healthcheck
  uses wrong port; (2) `getServiceHealth` in games.js can crash node
  via unhandled promise rejection under Node 24+; (3) UA-banlist
  middleware rejects HEAD requests with 405. None block the replica
  (workarounds in `docker-compose.fork.yml`); all three need real
  fixes upstream.

---

## Glossary of decisions deferred to Notes

These show up across multiple phases and need to be documented in this
plan's Notes as soon as they're made:

- **Droplet region** chosen and rationale (Phase A).
- **Image registry namespace** for the fork's images (Phase B; affects
  Phase D).
- **Whether to reuse personal SSH key or generate deploy-only key** for
  GitHub Actions (Phase D).
- **Origin Certificate expiration date** so it can hit a calendar reminder
  (Phase C).
- **Caddy version** in case future debugging needs it (Phase C).
