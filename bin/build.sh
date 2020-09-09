#!/bin/bash

TAG="kubesail/agent:v$(cat VERSION.txt)"

docker buildx build --platform linux/amd64,linux/arm64,linux/arm/v7 -t ${TAG}  --push .
