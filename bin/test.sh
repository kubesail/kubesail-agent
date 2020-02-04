#!/bin/bash
set -euf -o pipefail

TEST_TARGET="${1:-test-gateway}"

kubectl exec -it $(kubectl get pods -l app=kubesail-gateway -o name | awk -F'/' '{print $2}') bin/${TEST_TARGET}
