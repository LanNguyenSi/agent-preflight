FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  composer \
  curl \
  docker.io \
  git \
  gradle \
  maven \
  openjdk-17-jdk \
  php-cli \
  python3 \
  python3-pip \
  python3-venv \
  unzip \
  && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages \
  mypy \
  pip-audit \
  pytest \
  ruff

ARG ACT_VERSION=v0.2.82
RUN curl -fsSL "https://github.com/nektos/act/releases/download/${ACT_VERSION}/act_Linux_x86_64.tar.gz" \
  | tar -xz -C /usr/local/bin act \
  && chmod +x /usr/local/bin/act

WORKDIR /app

COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
RUN npm ci

COPY src ./src
COPY README.md ./
RUN npm run build

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["run", "/workspace"]
