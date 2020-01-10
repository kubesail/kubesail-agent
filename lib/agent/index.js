// @flow

/* flow-include
export type KsAgentConfig = {
  kubeapiEndpoint?: string,
  namespace?: string|Array<string>
}
*/

const fs = require('fs')
const net = require('net')
const url = require('url')

const sni = require('url')
const httpHeaders = require('http-headers')
const { Client } = require('kubernetes-client')

const logger = require('../shared/logger')
const { _prom, initProm } = require('../shared/prom')
const { AGENT_HTTP_LISTEN_PORT, AGENT_HTTPS_LISTEN_PORT } = require('../shared/config')

class KsAgent {
  constructor(config /*: KsAgentConfig */) {
    this.config = config
    if (this.config.namespace) {
      this.namespace = this.config.namespace
    } else {
      this.namespace = fs
        .readFileSync('/run/secrets/kubernetes.io/serviceaccount/namespace')
        .toString()
    }
    if (!this.config.ingressControllerNamespace) this.config.ingressControllerNamespace = 'default'
    if (!this.config.ingressControllerEndpoint)
      this.config.ingressControllerEndpoint = 'my-ingress-controller-nginx-ingress'
  }

  client /*: ?Client */
  config /*: Object */
  namespace /*: string */
  endpoints /*: Array<Object> */
  tunnel /*: Socket */
  http /*: Server */
  https /*: Server */
  headers /*: Array<string> */ = [
    'HTTP/1.1 404 Not Found',
    'Server: kubesail-agent',
    `Date: ${new Date()}`,
    'Content-Type: text/plain'
  ]

  async init() {
    initProm()

    this.http = net.createServer({}, this.connectionHandler('http'))
    this.http.on('error', this.serverErrorHandler)

    this.https = net.createServer({}, this.connectionHandler('https'))
    this.https.on('error', this.serverErrorHandler)

    this.client = new Client()
    const spec = await this.client.backend.http({ method: 'GET', pathname: '/openapi/v2' })
    this.client._addSpec(spec.body)
    this.kubeApiUrl = new url.URL(this.client.backend.requestOptions.baseUrl)

    await this.findIngressControllerEndpoints()
    await this.watchForEndpointChanges()

    this.http.listen(AGENT_HTTP_LISTEN_PORT, () => {
      this.https.listen(AGENT_HTTPS_LISTEN_PORT, () => {
        logger.info('kubesail-agent ready!', {
          namespace: this.namespace,
          AGENT_HTTP_LISTEN_PORT,
          AGENT_HTTPS_LISTEN_PORT,
          kubeApi: this.kubeApiUrl.host,
          endpoints: this.endpoints
        })
      })
    })
  }

  async findIngressControllerEndpoints() {
    const endpoint = await this.client.api.v1
      .namespaces(this.config.ingressControllerNamespace)
      .endpoints(this.config.ingressControllerEndpoint)
      .get()

    this.addEndpoint(endpoint.body)
  }

  async addEndpoint(endpoint /*: Object */) {
    this.endpoints = Array.prototype.concat(
      ...endpoint.subsets.map(subset => {
        return subset.addresses.map(address => address.ip)
      })
    )
  }

  async watchForEndpointChanges() {
    if (!this.client) throw new Error('Unable to establish Kube API connection')

    const stream = await this.client.api.v1.watch
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
        this.addEndpoint(event.object)
      }
    })
  }

  // connect to service
  connectToService() {
    // Connect to kubesail api
  }

  handleHTTPSRequest(domain /*: Object */, connection /*: Object */, buffer /*: string */) {
    console.log('https', domain)
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

  connectionHandler(http /*: string */ = 'http') {
    return (connection /*: Object */) => {
      let buffer = ''
      connection.on('data', data => {
        buffer += data
        if (http === 'http') {
          const request = httpHeaders(buffer)
          if (request) {
            this.handleHTTPRequest(request, connection, buffer)
            buffer = ''
          }
        } else if (http === 'https') {
          const domain = sni(data)
          if (domain) {
            this.handleHTTPSRequest(domain, connection, data)
            buffer = ''
          }
        }
      })
    }
  }
}

module.exports = KsAgent
