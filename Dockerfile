# Napoleon — standalone API.
#
# Build stage: install, generate the Prisma client, compile.
FROM node:22-slim AS build
WORKDIR /app

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
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

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# The generated client is a build artefact, so carry it across explicitly.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY scripts ./scripts

EXPOSE 3010

# Push the schema, then serve. `db push` keeps a single-service deploy simple;
# switch to `prisma migrate deploy` once the schema is stable and you care about
# migration history.
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/main"]
