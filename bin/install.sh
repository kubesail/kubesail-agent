#!/bin/bash
set -e

TAG="kubesail/agent:v$(cat VERSION.txt)"

git checkout -- .yarn
docker build -t ${TAG}-pnp -f Dockerfile-pnp .
docker run --rm -d --name=kubesail-agent-pnp --entrypoint=sleep ${TAG}-pnp 30
docker cp kubesail-agent-pnp:/home/node/app/.pnp.cjs .
rm -rfv .yarn
docker cp kubesail-agent-pnp:/home/node/app/.yarn .yarn
docker kill kubesail-agent-pnp
git checkout -- .yarn/releases/*
