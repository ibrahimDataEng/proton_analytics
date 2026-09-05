# ---- Build stage: compile TypeScript to dist/ ----
FROM node:20-alpine AS build

WORKDIR /app

# Install all dependencies (including dev) — tsc is needed to build.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies so node_modules can be copied into the runtime stage as-is.
RUN npm prune --omit=dev

# ---- Runtime stage: production dependencies + compiled output only ----
FROM node:20-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Run as the unprivileged user that ships with the base image.
USER node

EXPOSE 4000

CMD ["node", "dist/server.js"]
