FROM node:16-buster-slim
USER node
WORKDIR /home/node/app
COPY --chown=node:node . .
COPY --chown=node:node k8s/overlays/dev/secrets ./secrets/

ENV NODE_ENV "production"
RUN yarn config set enableNetwork false && \
  yarn install --immutable --immutable-cache && \
  rm -rf /home/node/app/.yarn

ENV NODE_OPTIONS "--require /home/node/app/.pnp.cjs"
CMD ["/home/node/app/bin/node.sh", "agent"]
