FROM node:16-buster-slim
USER node
WORKDIR /home/node/app
COPY --chown=node:node . .
COPY k8s/overlays/dev/secrets ./secrets/

RUN yarn config set enableNetwork false
RUN yarn install --immutable --immutable-cache

ENV NODE_ENV "production"
ENV NODE_OPTIONS "--require /home/node/app/.pnp.cjs"
CMD ["/home/node/app/bin/node.sh", "agent"]
