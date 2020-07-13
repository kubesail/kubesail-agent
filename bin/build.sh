#!/bin/bash

TAG="kubesail/agent:v$(cat VERSION.txt)"

docker build -t ${TAG} .
docker push ${TAG}