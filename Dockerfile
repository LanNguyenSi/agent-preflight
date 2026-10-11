FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive

ARG EXTRA_APT_PACKAGES=""
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
  $EXTRA_APT_PACKAGES \
  && rm -rf /var/lib/apt/lists/*

ARG EXTRA_PIP_PACKAGES=""
RUN pip3 install --break-system-packages \
  mypy \
  pip-audit \
  pytest \
  ruff \
  $EXTRA_PIP_PACKAGES

# ACT_SHA256_AMD64 / ACT_SHA256_ARM64 are the act_Linux_x86_64.tar.gz and
# act_Linux_arm64.tar.gz entries of the release's checksums.txt; update all
# three args together when bumping ACT_VERSION. TARGETARCH is set by BuildKit;
# the legacy builder leaves it empty, so fall back to the build platform's
# Debian architecture. Any other architecture fails the build.
ARG ACT_VERSION=v0.2.89
ARG ACT_SHA256_AMD64=0191d6f1f3b716b5c55820032605d05fc3c1cdbf581ebeff655019e5dd1524c0
ARG ACT_SHA256_ARM64=daa8679ba9615a74d2d0cec321dc593f21948a2a11bb65862b063d8b930f4bcb
ARG TARGETARCH
RUN set -eu; \
  arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
  case "$arch" in \
    amd64) asset=act_Linux_x86_64.tar.gz; sha="$ACT_SHA256_AMD64" ;; \
    arm64) asset=act_Linux_arm64.tar.gz; sha="$ACT_SHA256_ARM64" ;; \
    *) echo "unsupported architecture for act: $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/act.tar.gz "https://github.com/nektos/act/releases/download/${ACT_VERSION}/${asset}"; \
  echo "${sha}  /tmp/act.tar.gz" | sha256sum -c -; \
  tar --no-same-owner -xz -C /usr/local/bin -f /tmp/act.tar.gz act; \
  rm /tmp/act.tar.gz; \
  chmod 0755 /usr/local/bin/act

ARG SANDBOX_PROFILE=default
LABEL io.agent-preflight.sandbox-profile="${SANDBOX_PROFILE}"

WORKDIR /app

COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
RUN npm ci

COPY src ./src
COPY README.md ./
RUN npm run build

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["run", "/workspace"]
