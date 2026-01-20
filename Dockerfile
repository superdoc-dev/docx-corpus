FROM oven/bun:latest

WORKDIR /app

# Install Python and uv
RUN apt-get update && apt-get install -y python3 python3-venv curl --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# Copy package files for caching
COPY package.json bun.lock ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/scraper/package.json ./packages/scraper/
COPY packages/extractor/package.json ./packages/extractor/
COPY packages/embedder/package.json ./packages/embedder/
COPY apps/cli/package.json ./apps/cli/
COPY packages/extractor/python/pyproject.toml packages/extractor/python/uv.lock ./packages/extractor/python/

# Install all dependencies
RUN bun install && cd packages/extractor/python && uv sync

# Copy source files
COPY tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/cli/ ./apps/cli/

ENTRYPOINT ["tail", "-f", "/dev/null"]
