#!/usr/bin/env bash
set -euf -o pipefail

./bin/generate_self_signed_cert.sh

LOCAL_DEV_SECRET_FILE="k8s/overlays/dev/secrets/env.plain"

if [ ! -f ${LOCAL_DEV_SECRET_FILE} ]; then
  read -p "Please enter your KubeSail username:" -n 1 -r
  echo

  echo "$REPLY" > $LOCAL_DEV_SECRET_FILE
fi

skaffold dev --port-forward
