FROM oven/bun:alpine

WORKDIR /app

# Copy dependency files first (layer caching)
COPY package.json bun.lock* ./

# Install dependencies (production only)
RUN bun install --frozen-lockfile --production

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# Keep container running for interactive CLI use
CMD ["tail", "-f", "/dev/null"]
