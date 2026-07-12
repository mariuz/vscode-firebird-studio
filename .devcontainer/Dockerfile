FROM mcr.microsoft.com/devcontainers/javascript-node:24

# firebird3.0-utils provides isql-fb, used by scripts/seed-test-db.js's manual counterpart and by
# the extension's own isql terminal integration when testing inside the container.
RUN apt-get update && apt-get install -y --no-install-recommends firebird3.0-utils \
    && rm -rf /var/lib/apt/lists/*
