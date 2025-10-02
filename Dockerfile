FROM node:20-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Install only production deps (copy manifest(s) first)
COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; \
    elif [ -f yarn.lock ]; then corepack enable && yarn install --production --frozen-lockfile; \
    elif [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --prod --frozen-lockfile; \
    else npm install --omit=dev; fi

# Copy minimal runtime source (avoid tests, local storage, superseded assets)
COPY src ./src
COPY scripts ./scripts
COPY db ./db
COPY .env.example ./

EXPOSE 4000
CMD ["node", "src/server.js"]
