FROM node:12-alpine

WORKDIR /app

ENV NODE_ENV="production"

RUN apk update && \
  apk upgrade && \
  apk --no-cache add ca-certificates git bash python curl && \
  update-ca-certificates

COPY package.json yarn.lock .eslintrc.json ./

RUN yarn install --production

COPY bin ./bin
COPY k8s/overlays/dev/secrets ./secrets/
COPY test ./test
COPY lib ./lib
COPY VERSION.txt package.json ./

CMD ["/app/bin/kubesail-agent"]
