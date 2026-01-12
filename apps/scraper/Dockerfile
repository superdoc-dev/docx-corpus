FROM oven/bun:alpine

RUN apk add --no-cache bash curl

WORKDIR /app

COPY package.json bun.lock* ./

RUN bun install --frozen-lockfile --production --ignore-scripts

COPY . .

CMD ["tail", "-f", "/dev/null"]
