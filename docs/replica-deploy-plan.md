# Replica deploy plan

Stand up `sports.unseen-university.org` as a parallel testing environment that
mirrors upstream production (DigitalOcean droplet running the existing Docker
Compose stack), fronted by Cloudflare for DNS + TLS, with GitHub Actions
deploying from this fork. Once it's healthy, perf-plan tasks 9–10 unblock and
migration-plan Phase 0 starts on a real environment.

## Status

- **Phase A — DigitalOcean droplet**: not started
- **Phase B — First manual deploy**: not started
- **Phase C — Cloudflare DNS + TLS**: not started
- **Phase D — GitHub Actions CI/CD on fork**: not started
- **Phase E — Capture baseline metrics**: not started
- Last updated: 2026-04-26

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

- ☐ Create a DigitalOcean account and add a payment method, if not already
  done.
  > **USER ACTION**: Sign up at digitalocean.com.
- ☐ Add your SSH public key (`~/.ssh/id_ed25519.pub`) to your DO account.
  Settings → Security → SSH Keys → Add SSH Key. Use the same one you set
  up for GitHub earlier this week — it's already on disk.
  > **USER ACTION**: Paste the public key into the DO dashboard.
- ☐ Create the droplet:
  - **Image**: Ubuntu 24.04 LTS x64
  - **Plan**: Basic, Regular SSD, **s-2vcpu-4gb** ($24/mo)
  - **Region**: pick the closest to where most baseline traffic will come
    from. NYC1 if you're east-coast.
  - **Authentication**: SSH key (the one you just added)
  - **Hostname**: `sports-unseen-university` (shows up in `hostname` and
    DO dashboard)
  - Skip backups, skip monitoring agents for now.
  > **USER ACTION**: Click "Create Droplet" and wait ~60 seconds for
  > provisioning. Note the public IPv4 address — it'll be used in Phases C
  > and D.
- ☐ Verify SSH:
  `ssh root@<droplet-ip>` — should land in a root shell on the new box.
- ☐ Create a non-root user with sudo, disable root login, leave SSH on
  port 22 (Cloudflare Tunnel deferred to migration plan):
  ```bash
  ssh root@<droplet-ip> bash -s <<'EOF'
    adduser --disabled-password --gecos "" deploy
    usermod -aG sudo deploy
    mkdir -p /home/deploy/.ssh
    cp /root/.ssh/authorized_keys /home/deploy/.ssh/
    chown -R deploy:deploy /home/deploy/.ssh
    chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
    sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
    systemctl restart ssh
  EOF
  ```
  Verify: `ssh deploy@<droplet-ip>` works; `ssh root@<droplet-ip>` is now
  rejected.
- ☐ Configure UFW to allow only SSH for now (HTTPS opens in Phase C):
  ```bash
  ssh deploy@<droplet-ip> sudo bash -s <<'EOF'
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow OpenSSH
    ufw --force enable
    ufw status
  EOF
  ```
- ☐ Enable unattended security upgrades:
  ```bash
  ssh deploy@<droplet-ip> sudo bash -s <<'EOF'
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y unattended-upgrades
    dpkg-reconfigure -plow unattended-upgrades
  EOF
  ```
- ☐ Install Docker + Compose plugin (official upstream package, not the
  snap):
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

- `ssh deploy@<droplet-ip>` works without sudo prompt.
- `ssh root@<droplet-ip>` is rejected.
- `ufw status` shows only SSH allowed.
- `docker compose version` reports v2.x.

### Notes

_(fill in as you go: droplet IP, region chosen, anything that broke during
hardening, when unattended-upgrades was last seen running)_

---

## Phase B — First manual deploy

**Outcome**: The Compose stack is running on the droplet on port 8000 (still
direct, no TLS yet). `curl http://<droplet-ip>:8000/cfb/healthcheck` returns
200. Validates the droplet can host the stack before automating CI/CD.

**Estimate**: 30–45 min.

**Rollback**: `docker compose down` and either redeploy a known-good image
tag or destroy the droplet.

### Tasks

- ☐ Decide where the fork's container images live. Recommendation:
  `ghcr.io/blackcb/game-on-paper-{node,python,redis,cache}` (your fork's
  GHCR, parallel to the upstream's `ghcr.io/saiemgilani/...`). Document
  the choice in Notes — used in Phase D.
- ☐ Build and push images **from your laptop** for this initial deploy
  (Phase D automates this):
  > **USER ACTION**: Generate a GHCR Personal Access Token with
  > `write:packages` and `read:packages` scopes at
  > <https://github.com/settings/tokens/new?scopes=write:packages,read:packages>
  > and save it locally. Then:
  ```bash
  echo $GHCR_TOKEN | docker login ghcr.io -u blackcb --password-stdin
  cd ~/Dev/game-on-paper-app

  docker buildx build --platform linux/amd64 \
    -t ghcr.io/blackcb/game-on-paper-node:latest \
    -f frontend/Dockerfile frontend --push

  docker buildx build --platform linux/amd64 \
    -t ghcr.io/blackcb/game-on-paper-python:latest \
    -f python/Dockerfile python --push

  docker buildx build --platform linux/amd64 \
    -t ghcr.io/blackcb/game-on-paper-redis:latest \
    -f redis/Dockerfile.lru redis --push

  docker buildx build --platform linux/amd64 \
    -t ghcr.io/blackcb/game-on-paper-cache:latest \
    -f redis/Dockerfile.cache redis --push
  ```
  Verify in <https://github.com/blackcb?tab=packages> that all four images
  show up.
- ☐ Make the four package visibilities public (so the droplet can pull
  without auth):
  > **USER ACTION**: For each package, Package settings → Change visibility
  > → Public. Cleaner than provisioning a registry-read PAT on the droplet.
- ☐ Create a fork-specific compose override file at
  `docker-compose.fork.yml` that points at your fork's images (and includes
  the `NODE_ENV=production` that's already in `docker-compose.do.yml`).
  This file is committed to your dev branch but never to the upstream PR.
  Skeleton:
  ```yaml
  services:
    redis:
      image: ghcr.io/blackcb/game-on-paper-redis:latest
    cache:
      image: ghcr.io/blackcb/game-on-paper-cache:latest
    summary:
      image: ghcr.io/akeaswaran/akeaswaran/cfb-team-summaries:latest
    node:
      image: ghcr.io/blackcb/game-on-paper-node:latest
      command: ["node", "server.js"]
      environment:
        RDATA_BASE_URL: "http://python:7000"
        NODE_ENV: production
      ports: ["8000:8000"]
      depends_on: [python, summary, redis, cache]
    python:
      image: ghcr.io/blackcb/game-on-paper-python:latest
  ```
  (Copy resource limits + healthchecks from `docker-compose.do.yml`; just
  swap image references.)
- ☐ Copy the file to the droplet:
  `scp docker-compose.fork.yml deploy@<droplet-ip>:~/docker-compose.yml`
- ☐ SSH in and start the stack:
  ```bash
  ssh deploy@<droplet-ip>
  cd ~
  docker compose pull
  docker compose up -d
  docker compose ps     # all 5 services should show "healthy" within 60s
  docker compose logs --tail=50 node    # sanity check
  ```
- ☐ Verify locally from your laptop (port 8000 still firewalled — use SSH
  tunnel for now):
  ```bash
  ssh -L 8000:localhost:8000 deploy@<droplet-ip>
  # in another terminal:
  curl -i http://localhost:8000/cfb/healthcheck
  curl -is http://localhost:8000/cfb/ | head
  ```
  The second curl should show a `Server-Timing:` header (proof the Day 1
  instrumentation is live in the deployed image).

### Acceptance

- `docker compose ps` on the droplet shows all 5 services healthy.
- `curl http://localhost:8000/cfb/healthcheck` (via SSH tunnel) returns
  `{"status":"ok"}` from python and matching node response.
- `Server-Timing` header appears on `/cfb/` and `/cfb/game/401403910`.

### Notes

_(fill in: which images registry chosen, any platform/build issues — Apple
Silicon → linux/amd64 build is mandatory; how long the cold start took;
memory observed via `docker stats`)_

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

- ☐ Confirm `unseen-university.org` is on Cloudflare and you have admin
  access. (You already added the CF Web Analytics token for this domain,
  so it should be.)
- ☐ Add an `A` record:
  - **Name**: `sports`
  - **IPv4 address**: droplet IP from Phase A
  - **Proxy status**: **Proxied** (orange cloud)
  - **TTL**: Auto
- ☐ Generate a Cloudflare Origin Certificate:
  Cloudflare dashboard → SSL/TLS → Origin Server → Create Certificate.
  - **Hostnames**: `sports.unseen-university.org`,
    `*.sports.unseen-university.org`
  - **Validity**: 15 years
  - **Key type**: ECC (smaller, faster)
  Save the certificate (PEM) and private key locally — don't commit them.
- ☐ On the droplet, install Caddy as a reverse proxy that terminates TLS
  with the Origin Certificate and proxies to the node container:
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
- ☐ Copy the Origin Certificate + key to the droplet:
  ```bash
  scp origin.pem deploy@<droplet-ip>:/tmp/origin.pem
  scp origin.key deploy@<droplet-ip>:/tmp/origin.key
  ssh deploy@<droplet-ip> sudo bash -s <<'EOF'
    mv /tmp/origin.pem /etc/caddy/certs/origin.pem
    mv /tmp/origin.key /etc/caddy/certs/origin.key
    chown root:caddy /etc/caddy/certs/*
    chmod 640 /etc/caddy/certs/*
  EOF
  ```
- ☐ Write `/etc/caddy/Caddyfile` with the reverse proxy config:
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
  Then: `sudo systemctl restart caddy && sudo systemctl status caddy`.
- ☐ Open UFW for Cloudflare's IP ranges only on 443 (and keep 80 closed —
  Cloudflare proxy serves HTTPS to the browser, talks HTTPS to origin):
  ```bash
  ssh deploy@<droplet-ip> sudo bash -s <<'EOF'
    for ip in $(curl -s https://www.cloudflare.com/ips-v4/); do
      ufw allow from $ip to any port 443 proto tcp
    done
    for ip in $(curl -s https://www.cloudflare.com/ips-v6/); do
      ufw allow from $ip to any port 443 proto tcp
    done
    ufw status numbered
  EOF
  ```
  Origin direct-to-IP HTTPS will fail from anywhere except Cloudflare —
  that's the point. Bookmark <https://www.cloudflare.com/ips/> for refreshes
  (rare but does happen).
- ☐ In Cloudflare dashboard → SSL/TLS → Overview, set encryption mode to
  **Full (strict)**. Browser ↔ CF and CF ↔ origin are both real TLS now.
- ☐ Verify in a fresh browser tab:
  - `https://sports.unseen-university.org/cfb/` loads with a valid
    padlock.
  - `curl -I https://sports.unseen-university.org/cfb/` shows
    `cf-ray: ...` and `Server-Timing` headers.
  - `curl -I http://<droplet-ip>:443` from your laptop fails with a TLS
    error or connection-refused (origin won't talk to non-Cloudflare IPs).
- ☐ Bonus: in Cloudflare → Rules → Page Rules (or Cache Rules in the new
  dashboard), confirm **no** caching rules are configured yet. The default
  CF "static asset auto-caching" is fine, but explicit `/assets/*`
  long-TTL belongs in migration-plan Phase 0 so the delta is measurable.

### Acceptance

- `https://sports.unseen-university.org/cfb/` renders the scoreboard.
- Cloudflare dashboard SSL/TLS shows "Full (strict)".
- `curl -I https://<droplet-ip>` from outside Cloudflare's IP range fails.
- `Server-Timing` header survives the Caddy + Cloudflare round trip.

### Notes

_(fill in: TLS mode chosen, Origin Certificate expiration date for the
calendar, any Caddy config tweaks, observed cf-cache-status values for
sanity)_

---

## Phase D — GitHub Actions CI/CD on fork

**Outcome**: Pushing to `instrument-plus-cloudflare-cdn` builds the four
images, pushes to your fork's GHCR, and re-deploys the droplet — all
automated. Replaces the manual Phase B steps for ongoing work.

**Estimate**: 60–90 min.

**Rollback**: Disable the workflow in Actions tab; revert to manual Phase B
flow.

### Tasks

- ☐ Generate two GitHub Actions secrets via repo Settings → Secrets:
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
- ☐ Restore the archived workflow as a fork-specific deploy at
  `.github/workflows/fork-deploy.yml` (don't reuse `deploy.yml` — keeps it
  visually distinct from upstream's, and prevents accidentally syncing it
  back upstream). Trigger only on the dev branch:
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
- ☐ Commit `fork-deploy.yml` and `docker-compose.fork.yml` on the dev
  branch. **Do not** commit them to `instrumentation-pr` — those files are
  fork-only.
- ☐ Push the dev branch and watch the workflow run in GitHub Actions →
  Actions tab.
- ☐ First run will take 5–10 min (no cache yet); subsequent runs ~2 min.
- ☐ After the workflow succeeds, verify:
  `curl -I https://sports.unseen-university.org/cfb/` reflects the latest
  image (confirm via a known-different output, e.g., `Server-Timing` value
  changes).
- ☐ Add a deploy badge to the dev branch's README (or skip — fork only).

### Acceptance

- Pushing to `instrument-plus-cloudflare-cdn` triggers a green workflow.
- All four images are rebuilt and pushed to the fork's GHCR.
- Droplet picks up the new images within ~30 seconds of the deploy job
  finishing.
- `Server-Timing` instrumentation continues to fire post-deploy.

### Notes

_(fill in: secrets created, first deploy duration, any image-build flakes
on Apple Silicon → amd64, cache hit ratio after 2nd run)_

---

## Phase E — Capture baseline metrics

**Outcome**: Perf-plan Day 1 task 10 is complete. The Baseline metrics block
in [perf-plan.md](perf-plan.md) is fully populated with numbers from the
replica.

**Estimate**: 24–48h elapsed (most of it is waiting), 30–45 min of active
work.

### Tasks

- ☐ Hit `https://sports.unseen-university.org/cfb/` and
  `/cfb/game/401403910` from a fresh browser session. Confirm
  `Server-Timing` headers present.
- ☐ Verify Cloudflare Web Analytics is recording pageviews. Wait at least
  6h before drawing conclusions; 24h is better.
- ☐ Run Lighthouse against the three reference URLs from a desktop browser
  (Chrome DevTools → Lighthouse panel → Desktop preset → Performance
  category). Take median of three runs each:
  - `https://sports.unseen-university.org/cfb/`
  - `https://sports.unseen-university.org/cfb/game/401403910`
  - `https://sports.unseen-university.org/cfb/year/2024/teams/differential`
  Record the perf score in
  [perf-plan.md Baseline metrics](perf-plan.md#baseline-metrics).
- ☐ Capture page weight for homepage and game page from DevTools → Network
  → bottom status bar ("X requests, Y MB transferred"). Record both
  values.
- ☐ Capture TTFB for homepage and game page (DevTools → Network → click
  the document request → Timing → "Waiting for server response"). Record
  cold-cache and warm-cache numbers separately.
- ☐ After 24h of CF Web Analytics data, capture:
  - LCP p75 (homepage)
  - LCP p75 (game page)
  - Geographic split if data is rich enough — at minimum US vs.
    international
  Record in `perf-plan.md`.
- ☐ Mark perf-plan tasks 9 + 10 as ☑ in [perf-plan.md](perf-plan.md), set
  Day 1 status to "completed", and fill in the Day 1 Notes block with any
  surprises (numbers that differ from what we observed locally, etc.).
- ☐ Mark this plan's Status as completed.

### Acceptance

- Every `_tbd_` placeholder in `perf-plan.md` Baseline metrics is replaced
  with a real number (or marked N/A with reasoning if a metric truly
  doesn't apply).
- perf-plan Day 1 status flips to "completed".
- Migration-plan Phase 0 unblocks and you have a real before/after frame
  to measure CDN improvements against.

### Notes

_(fill in: Lighthouse scores per page, surprising deltas vs. local Docker
numbers, CF Web Analytics geographic distribution, any differences with
upstream production worth investigating later)_

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
