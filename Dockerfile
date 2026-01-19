FROM oven/bun:alpine

WORKDIR /app

# Copy package files first for better caching
COPY package.json bun.lock ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/scraper/package.json ./packages/scraper/
COPY packages/extractor/package.json ./packages/extractor/
COPY apps/cli/package.json ./apps/cli/

# Install dependencies
RUN bun install

# Copy source files
COPY tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/cli/ ./apps/cli/

ENTRYPOINT ["bun", "run", "corpus"]
