#!/bin/bash

APP_PATH="/home/node/app/bin/kubesail-agent"

if [[ "$1" == "gateway" ]]; then
  APP_PATH="/home/node/app/lib/gateway"
fi

if [[ "$1" == "agent" ]]; then
  mkdir -p /opt/kubesail &> /dev/null
  FB_VERSION="v6"
  FB_PATH=/opt/kubesail/pibox-framebuffer-$FB_VERSION
  if [[ ! -f $FB_PATH && -d /opt/kubesail ]]; then
    curl --connect-timeout 10 -sLo $FB_PATH https://github.com/kubesail/pibox-framebuffer/releases/download/$FB_VERSION/pibox-framebuffer
    chmod +x $FB_PATH
    rm -f /opt/kubesail/pibox-framebuffer
    ln -s $FB_PATH /opt/kubesail/pibox-framebuffer
  fi
fi

shift

if [[ $NODE_ENV == "development" ]]; then
  echo "Starting in DEVELOPMENT mode"
  yarn run nodemon \
    --watch lib \
    --ext js,json,yaml,plain \
    -- \
    --require /home/node/app/.pnp.cjs \
    --inspect=0.0.0.0:9229 \
    --stack_size=1200 \
    ${APP_PATH} $@
else
  node \
    --require /home/node/app/.pnp.cjs \
    --stack_size=1200 \
    ${APP_PATH} $@
fi
