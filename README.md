# kubesail-agent

[![Docker Pulls](https://img.shields.io/docker/pulls/kubesail/agent?style=for-the-badge)](https://hub.docker.com/r/kubesail/agent)

Allows a cluster or namespace to be managed by KubeSail.com

## Installation

Using Kubernetes RBAC:

`kubectl apply -f https://agent.kubesail.com/rbac.yaml`

Without RBAC:

`kubectl apply -f https://agent.kubesail.com/no-rbac.yaml`

If you're not sure if you have RBAC enabled in your cluster, can ran run the following to find out:

`kubectl api-versions | fgrep rbac > /dev/null && echo "RBAC is installed" || echo "No RBAC found"`

## Configuration

## Development
