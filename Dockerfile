FROM node:12-alpine

WORKDIR /app

ENV NODE_ENV="production"

RUN apk update && \
  apk upgrade && \
  apk --no-cache add ca-certificates git bash python curl && \
  update-ca-certificates

COPY package.json yarn.lock .eslintrc.json .flowconfig ./

RUN adduser -S nodejs && \
  chown -R nodejs /app && \
  chown -R nodejs /home/nodejs

COPY bin ./bin
COPY lib ./lib

RUN chown -R nodejs /app/lib /app/bin && \
  yarn install --production && \
  chmod +x /app/bin/*

USER nodejs

COPY package.json ./

CMD ["/app/bin/kubesail-agent"]
