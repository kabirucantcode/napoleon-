# Napoleon — standalone API.
#
# Build stage: install, generate the Prisma client, compile.
FROM node:22-slim AS build
WORKDIR /app

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --no-audit --no-fund

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production dependencies only.
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# `prisma` is a runtime dependency, not a dev one: the command below runs the CLI
# on every boot. With it in devDependencies, `--omit=dev` strips it and the
# container fails to start.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# The generated client is a build artefact, so carry it across explicitly.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY scripts ./scripts

EXPOSE 3010

# Preflight the one variable the container cannot run without. Without this, a
# missing DATABASE_URL surfaces as a Prisma P1012 repeated on every restart,
# which reads like a schema fault rather than an unset configuration value.
# `printenv` exits non-zero when the variable is absent or empty, which keeps
# this check free of shell interpolation.
#
# Then push the schema and serve. `db push` keeps a single-service deploy
# simple; switch to `prisma migrate deploy` once the schema is stable and you
# care about migration history.
CMD printenv DATABASE_URL | grep -q . || { echo 'FATAL: DATABASE_URL is not set. Add an environment variable named DATABASE_URL whose value is your Postgres connection string, then redeploy. On Railway: add a PostgreSQL service, then set DATABASE_URL on this service to the reference variable pointing at it.'; exit 1; }; npx prisma db push --accept-data-loss && node dist/main
