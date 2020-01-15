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

The following environment variables are available to be set:


| ENV Variable           | Description                                                 | Default                               |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------- |
| LOGGING_LABEL          | A helper tag added to each log-line                         | `kubesail-agent`                      |
| LOG_LEVEL              | Controls logger verbosity (silly, debug, info, warn, error) | `info`                                |
| METRICS_LISTEN_PORT    | Listen port for prometheus metrics                          | `5000`                                |
| AGENT_HTTP_LISTEN_PORT | Healthcheck port for agent                                  | `6000`                                |
| AGENT_GATEWAY_TARGET   | Target Gateway for agent registration                       | `https://gateway-portal.kubesail.com` |

## Development

Install [skaffold](https://skaffold.dev/) and have a Kubernetes context ready, then run:

`skaffold dev --port-forward`

That's it!
