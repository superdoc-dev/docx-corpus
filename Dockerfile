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

# Install TS dependencies
RUN bun install --ignore-scripts --no-frozen-lockfile --production

# Install Python dependencies (extractor)
COPY packages/extractor/python/pyproject.toml packages/extractor/python/uv.lock ./packages/extractor/python/
RUN cd packages/extractor/python && uv venv && \
    uv pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu --no-cache && \
    uv pip install -e . --no-cache

# Install Python dependencies (classification)
COPY scripts/classification/pyproject.toml ./scripts/classification/
RUN cd scripts/classification && uv venv && uv pip install -e .

# Install Python dependencies (export — uses inline script deps, uv handles it at runtime)

# Copy all source files
COPY tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/cli/ ./apps/cli/
COPY scripts/ ./scripts/

ENTRYPOINT ["tail", "-f", "/dev/null"]
