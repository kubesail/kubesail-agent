FROM node:16-bullseye-slim

RUN apt-get -yqq update && apt-get -yqq install bash curl

USER node
WORKDIR /home/node/app
ENV NODE_ENV "production"

COPY --chown=node:node k8s/overlays/dev/secrets ./secrets/
COPY --chown=node:node .yarn ./.yarn
COPY --chown=node:node .pnp.cjs package.json yarn.lock .yarnrc.yml ./

RUN yarn config set enableNetwork false && \
  yarn install --immutable --immutable-cache

COPY --chown=node:node . .

ENV NODE_OPTIONS "--require /home/node/app/.pnp.cjs"
ENV DBUS_SYSTEM_BUS_ADDRESS "unix:path=/host/run/dbus/system_bus_socket"

CMD ["/home/node/app/bin/node.sh", "agent"]
