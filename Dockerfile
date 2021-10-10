FROM node:16-buster-slim
USER node
WORKDIR /home/node/app
ENV NODE_ENV "production"

COPY --chown=node:node k8s/overlays/dev/secrets ./secrets/
COPY --chown=node:node .yarn ./.yarn
COPY --chown=node:node .pnp.cjs package.json yarn.lock .eslintrc.json .yarnrc.yaml ./

RUN yarn config set enableNetwork false && \
  yarn install --immutable --immutable-cache

COPY --chown=node:node . .

ENV NODE_OPTIONS "--require /home/node/app/.pnp.cjs"
CMD ["/home/node/app/bin/node.sh", "agent"]
