# Slim image for the cfb-team-summaries Node service.
#
# Source for the Express server is vendored under `summary/server/`,
# originally from https://github.com/akeaswaran/cfb-team-summaries.
# The CSV data files under `summary/data/` were extracted from the
# upstream `:latest` GHCR image (rebuilt periodically by upstream
# from the CollegeFootballData API). Refresh procedure:
#
#   docker pull ghcr.io/akeaswaran/akeaswaran/cfb-team-summaries:latest
#   docker create --name extract ghcr.io/.../cfb-team-summaries:latest
#   docker cp extract:/code/data summary/
#   docker rm extract
#
# The original upstream Dockerfile uses `node:lts` (a buildpack-deps
# variant) with a base of ~1 GB before any app code; this slim build
# trims that to `node:24-slim` (~80 MB) and produces a ~165 MB image.

# Stage 1: install deps + compile TypeScript.
FROM node:24-slim AS nodebuild

WORKDIR /build
COPY server/ ./

# Upstream installs typescript globally; we install it locally in the
# build stage so it stays in /build/src/node_modules and never leaks
# into the runtime image.
WORKDIR /build/src
# typescript@5.4 matches what this codebase was originally built
# against. Newer TS (5.5+) requires explicit `rootDir` in tsconfig
# and would force a doc-changing edit to the upstream config.
RUN npm install && npm install --save-dev typescript@5.4

# tsconfig at /build/tsconfig.json has `outDir: "./build"`, so output
# lands at /build/build relative to the tsconfig file. Invoke the
# locally-installed compiler directly — `npx tsc` resolves to a
# squatter package on npm whose author squats the bare `tsc` name.
WORKDIR /build
RUN ./src/node_modules/.bin/tsc

# Drop dev dependencies before we copy node_modules to runtime.
WORKDIR /build/src
RUN npm prune --omit=dev

# Stage 2: runtime. Just the slim base, the compiled server, prod
# node_modules, and the data files.
FROM node:24-slim
WORKDIR /code

COPY --from=nodebuild /build/build ./
COPY --from=nodebuild /build/src/node_modules ./node_modules
COPY data ./data

ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "./app.js"]
