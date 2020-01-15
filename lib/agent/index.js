// @flow

/* flow-include
export type KsAgentConfig = {
  namespace?: string|Array<string>,
  ingressControllerNamespace?: string,
  ingressControllerEndpoint?: string
}
*/

const fs = require('fs')
const net = require('net')
const http = require('http')
const url = require('url')

const sni = require('url')
const httpHeaders = require('http-headers')
const { Client } = require('kubernetes-client')

const logger = require('../shared/logger')
const { prom, initProm } = require('../shared/prom')
const { AGENT_HTTP_LISTEN_PORT, AGENT_GATEWAY_TARGET } = require('../shared/config')

class KsAgent {
  // Config as read by ./lib/shared/config.js
  config /*: KsAgentConfig */ = {
    ingressControllerNamespace: 'default',
    ingressControllerEndpoint: 'my-ingress-controller-nginx-ingress'
  }

  // Used to track resources in the cluster we're in.
  // Endpoints are tracked to follow the ingress controller we'll be passing traffic to
  // Services will be tracked in the future to pass traffic directly, rather than using an ingress controller (ie: we'll be the ingress controller)
  // Certificates will be tracked so that we can possibly provide totally valid HTTPS end-to-end without using the SNI tricks.
  resources /*: { endpoints: Array<Object>, services: Array<Object>, certificates: Array<Object> } */ = {
    endpoints: [],
    services: [],
    certificates: []
  }

  // Indicates agent is ready to take traffic
  // will fail healthchecks when falsey (used mainly to prevent recieving traffic before we're ready)
  agentReady = false

  // A 'kubernetes-client' connection to the cluster we're located in, using our in-pod service account
  k8sClient /*: Client */ = new Client()

  // Derive the kubeApi URL from our loaded service account backend (returns a local address like 10.x.x.x)
  kubeApiUrl = new url.URL(this.k8sClient.backend.requestOptions.baseUrl)

  // The ingressProxy is a persistent connection to the ingress controller, where we'll pass traffic
  ingressProxy /*: ?Object */

  // The k8sProxy is a persistent connection to the kubeapi, where we'll pass traffic
  k8sProxy /*: Object */

  // The Agent's http server is primarily used for healthchecks and nothing more
  http = http.createServer((_req, res) => {
    if (this.agentReady) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OK')
    } else {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      res.end('Not Healthy')
    }
  })

  constructor(config /*: KsAgentConfig */ = {}) {
    this.config = Object.assign({}, this.config, config)

    // Load namespace programatically if we're in a Kube cluster
    if (!this.config.namespace) {
      const namespaceFile = '/run/secrets/kubernetes.io/serviceaccount/namespace'
      if (fs.existsSync(namespaceFile)) {
        this.config.namespace = fs.readFileSync(namespaceFile).toString()
      } else {
        throw new Error(
          'Could not determine our namespace and none defined in config! Are we running in a Kubernetes cluster?'
        )
      }
    }

    this.http.on('error', function serverErrorHandler(error /*: Error */) {
      throw error
    })
  }

  // Starts the Agent service, connects tunnels and marks agentReady when ready.
  async init() {
    // Begins the metrics service
    initProm()

    // Load specific openapi spec for the cluster we're in - this is a bit slow but it helps support various versions of kube better.
    const spec = await this.k8sClient.backend.http({ method: 'GET', pathname: '/openapi/v2' })
    this.k8sClient._addSpec(spec.body)

    // Determine the ingress controller's address and watch for future changes to it
    await this.findIngressControllerEndpoints()
    await this.watchForIngressEndpointChanges()

    this.http.listen(AGENT_HTTP_LISTEN_PORT, () => {
      this.agentReady = true
      logger.info('kubesail-agent ready!', {
        AGENT_GATEWAY_TARGET,
        namespace: this.config.namespace,
        kubeApi: this.kubeApiUrl.host,
        endpoints: this.resources.endpoints
      })
    })
  }

  // Tries to determine the endpoint for the ingress controller so we can pass traffic to it
  async findIngressControllerEndpoints() {
    const endpoint = await this.k8sClient.api.v1
      .namespaces(this.config.ingressControllerNamespace)
      .endpoints(this.config.ingressControllerEndpoint)
      .get()

    await this.setIngressControllerEndpoint(endpoint.body)
  }

  // Sets this.resources.endpoints to the address/port of the ingress controller
  async setIngressControllerEndpoint(endpoint /*: Object */) {
    this.resources.endpoints = Array.prototype.concat(
      ...endpoint.subsets.map(subset => {
        return subset.addresses.map(address => address.ip)
      })
    )
  }

  // Watch for changes to the ingress endpoint
  async watchForIngressEndpointChanges() {
    const stream = await this.k8sClient.api.v1.watch
      .namespaces(this.config.ingressControllerNamespace)
      .endpoints(this.config.ingressControllerEndpoint)
      .getObjectStream()

    stream.on('error', err => {
      logger.error('watchForIngressEndpointChanges() stream error', { errMsg: err.message })
    })
    stream.on('disconnect', () => {
      logger.info('watchForIngressEndpointChanges() stream disconnect', {})
      this.watchForIngressEndpointChanges()
    })

    stream.on('data', async event => {
      if (event.type === 'ADDED' || event.type === 'MODIFIED') {
        this.setIngressControllerEndpoint(event.object)
      }
    })
  }
}

module.exports = KsAgent
