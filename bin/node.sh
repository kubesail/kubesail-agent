#!/bin/sh

APP_PATH="/home/node/app/bin/kubesail-agent"
WATCH_PATH="lib/agent"

if [[ "$1" == "gateway" ]]; then
  APP_PATH="/home/node/app/lib/gateway"
  WATCH_PATH="lib/gateway"
fi

shift

if [[ $NODE_ENV == "development" && -f ./node_modules/.bin/nodemon ]]; then
  echo "Starting in DEVELOPMENT mode"
  ./node_modules/.bin/nodemon \
    --watch lib/shared \
    --watch "${WATCH_PATH}" \
    --ext js,json,yaml,plain \
    -- --inspect=0.0.0.0:9229 --stack_size=1200 ${APP_PATH} $@
else
  node --stack_size=1200 ${APP_PATH} $@
fi
