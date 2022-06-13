# syntax=docker/dockerfile:1.3

FROM node:18-bullseye-slim

RUN usermod -u 989 node && \
  mkdir -p /home/node/.dbus-keyrings && \
  chown -R node:node /home/node && \
  apt-get -yqq update && \
  apt-get -yqq install bash curl

USER node
WORKDIR /home/node/app
ENV NODE_ENV="production" \
  NODE_OPTIONS="--require /home/node/app/.pnp.cjs" \
  DBUS_SYSTEM_BUS_ADDRESS="unix:path=/host/run/dbus/system_bus_socket"

COPY --chown=node:node k8s/overlays/dev/secrets ./secrets/
COPY --chown=node:node .yarn ./.yarn
COPY --chown=node:node .pnp.cjs .pnp.loader.mjs package.json yarn.lock .yarnrc.yml ./

RUN yarn config set enableNetwork false && \
  yarn install --immutable --immutable-cache

COPY --chown=node:node . .

CMD ["/home/node/app/bin/node.sh", "agent"]
