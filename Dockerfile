# syntax=docker/dockerfile:1.3

FROM node:21-bullseye-slim AS base
RUN apt-get -yqq update && \
  apt-get -yqq install bash curl apt-utils python3 build-essential git procps
WORKDIR /home/node/app
ENV NODE_ENV="production"
COPY --chown=node:node .yarn ./.yarn
COPY --chown=node:node .pnp.cjs .pnp.loader.mjs package.json yarn.lock .yarnrc.yml ./
RUN yarn config set enableNetwork false && \
  yarn install --immutable --immutable-cache || bash -c "cat /tmp/*/build.log && exit 1"


FROM node:21-bullseye-slim AS runner
RUN usermod -u 989 node && \
  mkdir -p /home/node/.dbus-keyrings /opt/kubesail && \
  chown -R node:node /home/node /opt/kubesail && \
  apt-get -yqq update && \
  apt-get -yqq install bash curl ca-certificates nscd procps && \
  apt-get clean && \
  rm -rf /usr/share/postgresql/*/man /var/lib/apt/lists/* /var/log/apt /var/log/dpkg.log /var/log/alternatives.log && \
  curl -sL https://letsencrypt.org/certs/isrg-root-x1-cross-signed.pem -o /usr/local/share/ca-certificates/isrg-root-x1-cross-signed.crt && \
  curl -sL https://letsencrypt.org/certs/isrg-root-x2-cross-signed.pem -o /usr/local/share/ca-certificates/isrg-root-x2-cross-signed.crt && \
  curl -sL https://letsencrypt.org/certs/lets-encrypt-e1.pem -o /usr/local/share/ca-certificates/lets-encrypt-e1.crt && \
  curl -sL https://letsencrypt.org/certs/lets-encrypt-r3.pem -o /usr/local/share/ca-certificates/lets-encrypt-r3.crt && \
  curl -sL https://letsencrypt.org/certs/trustid-x3-root.pem.txt -o /usr/local/share/ca-certificates/trustid-x3-root.crt && \
  update-ca-certificates

USER node
WORKDIR /home/node/app
ENV NODE_ENV="production" \
  NODE_OPTIONS="--require /home/node/app/.pnp.cjs" \
  DBUS_SYSTEM_BUS_ADDRESS="unix:path=/host/run/dbus/system_bus_socket"

COPY --chown=node:node --from=base /home/node/app/ /home/node/app
COPY --chown=node:node k8s/overlays/dev/secrets ./secrets/
COPY --chown=node:node . .

CMD ["/home/node/app/bin/node.sh", "agent"]
