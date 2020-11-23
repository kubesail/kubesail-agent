FROM node:14-slim

WORKDIR /app

ENV NODE_ENV="production"

RUN apt-get update -yqq && \
  apt-get install -yqq git bash python curl

COPY package.json yarn.lock .eslintrc.json ./

RUN yarn install --production

COPY bin ./bin
COPY k8s/overlays/dev/secrets ./secrets/
COPY test ./test
COPY lib ./lib
COPY VERSION.txt package.json ./

CMD ["/app/bin/kubesail-agent"]
