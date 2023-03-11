#!/bin/bash

APP_PATH="/home/node/app/bin/kubesail-agent"

if [[ "$1" == "gateway" ]]; then
  APP_PATH="/home/node/app/lib/gateway"
fi

if [[ "$1" == "agent" ]]; then
  mkdir -p /opt/kubesail &> /dev/null
  architecture="arm64"
  case $(uname -m) in
      x86_64) architecture="amd64" ;;
      arm)    dpkg --print-architecture | grep -q "arm64" && architecture="arm64" || architecture="arm" ;;
  esac
  if [[ -d /opt/kubesail ]]; then
    echo "Updating provision-disk.sh"
    curl --connect-timeout 10 -Lo /opt/kubesail/provision-disk.sh https://raw.githubusercontent.com/kubesail/pibox-os/main/provision-disk.sh
    chmod +x /opt/kubesail/provision-disk.sh
    echo "Updating kubesail-support.sh"
    curl --connect-timeout 10 -Lo /opt/kubesail/kubesail-support.sh https://raw.githubusercontent.com/kubesail/pibox-os/main/kubesail-support.sh
    chmod +x /opt/kubesail/kubesail-support.sh
  fi
  # LATEST_FB_VERSION="$(curl --connect-timeout 10 -L https://raw.githubusercontent.com/kubesail/pibox-framebuffer/main/VERSION.txt)"
  LATEST_FB_VERSION="21"
  FB_VERSION="v${LATEST_FB_VERSION}"
  FB_PATH=/opt/kubesail/pibox-framebuffer-$FB_VERSION
  if [[ -n $LATEST_FB_VERSION && ! -f $FB_PATH && -d /opt/kubesail ]]; then
    FB_URL="https://github.com/kubesail/pibox-framebuffer/releases/download/$FB_VERSION/pibox-framebuffer-linux-${architecture}-$FB_VERSION"
    echo "Installing FrameBuffer service ${FB_VERSION} from ${FB_URL}"
    curl --connect-timeout 10 -Lo "$FB_PATH" "$FB_URL"
    if [[ -f $FB_PATH ]]; then
      chmod +x "$FB_PATH"
      rm -fv /opt/kubesail/pibox-framebuffer
      ln -sv $FB_PATH /opt/kubesail/pibox-framebuffer
      curl -s --unix-socket /var/run/pibox/framebuffer.sock "http://localhost/exit"
    else
      echo "Failed to install pibox-framebuffer service"
    fi
  fi
fi

shift

if [[ $NODE_ENV == "development" ]]; then
  echo "Starting in DEVELOPMENT mode"
  yarn run nodemon \
    --watch lib \
    --watch modules \
    --ext js,json,yaml,plain \
    -- \
    --require /home/node/app/.pnp.cjs \
    --inspect=0.0.0.0:9229 \
    --stack_size=1200 \
    ${APP_PATH} $@
else
  UV_THREADPOOL_SIZE=8 node \
    --require /home/node/app/.pnp.cjs \
    --stack_size=1200 \
    --max_semi_space_size=64 \
    --max-old-space-size=1500 \
    --inspect=9229 \
    ${APP_PATH} $@
fi
