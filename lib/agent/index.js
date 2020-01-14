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
const { _prom, initProm } = require('../shared/prom')
const { AGENT_HTTP_LISTEN_PORT, AGENT_GATEWAY_TARGET } = require('../shared/config')

class KsAgent {
  // Indicates agent is ready to take traffic
  // will fail healthchecks when falsey (used mainly to prevent recieving traffic before we're ready)
  agentReady = false

  // A 'kubernetes-client' connection to the cluster we're located in, using our in-pod service account
  k8sClient /*: ?Client */

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

  // The ingressProxy is a persistent connection to the ingress controller, where we'll pass traffic
  ingressProxy /*: ?Server */

  // The k8sProxy is a persistent connection to the kubeapi, where we'll pass traffic
  k8sProxy /*: Server */

  // The Agent's http server is primarily used for healthchecks and nothing more
  http /*: Server */

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
  }

  async init() {
    initProm()

    this.http = http.createServer((_req, res) => {
      if (this.agentHealthy) {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('OK')
      } else {
        res.writeHead(503, { 'Content-Type': 'text/plain' })
        res.end('Not Healthy')
      }
    })
    this.http.on('error', this.serverErrorHandler)

    this.k8sClient = new Client()
    const spec = await this.k8sClient.backend.http({ method: 'GET', pathname: '/openapi/v2' })
    this.k8sClient._addSpec(spec.body)
    this.kubeApiUrl = new url.URL(this.k8sClient.backend.requestOptions.baseUrl)

    await this.findIngressControllerEndpoints()
    await this.watchForEndpointChanges()

    this.http.listen(AGENT_HTTP_LISTEN_PORT, () => {
      this.agentHealthy = true
      logger.info('kubesail-agent ready!', {
        AGENT_GATEWAY_TARGET,
        namespace: this.config.namespace,
        kubeApi: this.kubeApiUrl.host,
        endpoints: this.endpoints
      })
    })
  }

  async findIngressControllerEndpoints() {
    const endpoint = await this.k8sClient.api.v1
      .namespaces(this.config.ingressControllerNamespace)
      .endpoints(this.config.ingressControllerEndpoint)
      .get()

    this.setEndpoint(endpoint.body)
  }

  async setEndpoint(endpoint /*: Object */) {
    this.endpoints = Array.prototype.concat(
      ...endpoint.subsets.map(subset => {
        return subset.addresses.map(address => address.ip)
      })
    )
  }

  async watchForEndpointChanges() {
    if (!this.k8sClient) throw new Error('Unable to establish Kube API connection')

    const stream = await this.k8sClient.api.v1.watch
      .namespaces(this.config.ingressControllerNamespace)
      .endpoints(this.config.ingressControllerEndpoint)
      .getObjectStream()

    stream.on('error', err => {
      logger.error('watchForEndpointChanges() stream error', { errMsg: err.message })
      this.watchForEndpointChanges()
    })
    stream.on('disconnect', () => {
      logger.info('watchForEndpointChanges() stream disconnect', {})
      this.watchForEndpointChanges()
    })

    stream.on('data', async event => {
      if (event.type === 'ADDED' || event.type === 'MODIFIED') {
        this.setEndpoint(event.object)
      }
    })
  }

  // connect to service
  connectToService() {
    // Connect to kubesail api
  }

  handleHTTPRequest(request /*: Object */, connection /*: Object */, buffer /*: string */) {}
  //   if (request && request.headers && request.headers.host) {
  //     const [host, _port] = request.headers.host.split(':')
  //     let firstBackend

  //     for (let iI = 0; iI < this.ingresses.length; iI++) {
  //       const ingress = this.ingresses[iI]
  //       for (let iR = 0; iR < ingress.spec.rules.length; iR++) {
  //         const rule = ingress.spec.rules[iR]
  //         if (rule.host === host) {
  //           for (let iP = 0; iP < rule.http.paths.length; iP++) {
  //             const { path, backend } = rule.http.paths[iP]
  //             if (path === request.url) {
  //               firstBackend = backend
  //               break
  //             }
  //           }
  //         }
  //         if (firstBackend) break
  //       }
  //       if (firstBackend) break
  //     }

  //     if (firstBackend) {
  //       const client = new net.Socket()
  //       client.connect(firstBackend.servicePort, firstBackend.serviceName, function() {
  //         client.write(buffer)
  //         client.pipe(connection)
  //         connection.pipe(client)
  //       })
  //       client.on('close', () => {
  //         connection.end()
  //       })
  //       client.on('error', err => {
  //         logger.error('Backend client had error:', err)
  //         connection.end()
  //       })
  //       connection.on('end', () => {
  //         client.end()
  //       })
  //       connection.on('error', err => {
  //         logger.error('Proxy connection had error:', err)
  //         client.end()
  //       })
  //     } else {
  //       logger.debug(`Ingress not matched`, { host })
  //       connection.write(this.headers.join('\n') + `\n\n404`)
  //       connection.end()
  //     }
  //   }
  // }

  serverErrorHandler(error /*: Error */) {
    throw error
  }

  // connectionHandler(http /*: string */ = 'http') {
  //   return (connection /*: Object */) => {
  //     let buffer = ''
  //     connection.on('data', data => {
  //       buffer += data
  //       if (http === 'http') {
  //         const request = httpHeaders(buffer)
  //         if (request) {
  //           this.handleHTTPRequest(request, connection, buffer)
  //           buffer = ''
  //         }
  //       } else if (http === 'https') {
  //         const domain = sni(data)
  //         if (domain) {
  //           this.handleHTTPSRequest(domain, connection, data)
  //           buffer = ''
  //         }
  //       }
  //     })
  //   }
  // }
}

module.exports = KsAgent
