// @flow

/* flow-include
export type KsAgentConfig = {
  kubeapiEndpoint?: string,
  namespace?: string|Array<string>
}
*/

const fs = require('fs')
const net = require('net')
const sni = require('sni')
const { Client } = require('kubernetes-client')
const httpHeaders = require('http-headers')

const logger = require('../shared/logger')
const { prom, initProm } = require('../shared/prom')
const { AGENT_HTTP_LISTEN_PORT, AGENT_HTTPS_LISTEN_PORT } = require('../shared/config')

const watchedIngresses = new prom.Gauge({
  name: 'watched_ingresses',
  help: 'Number of ingresses the Agent currently sees',
  registers: [prom.register]
})

class KsAgent {
  constructor(config /*: KsAgentConfig */) {
    this.config = config
    this.ingresses = []
    if (this.config.namespace) {
      this.namespace = this.config.namespace
    } else {
      this.namespace = fs
        .readFileSync('/run/secrets/kubernetes.io/serviceaccount/namespace')
        .toString()
    }
  }

  client /*: ?Client */
  config /*: Object */
  namespace /*: string */
  ingresses /*: Array<Object> */
  tunnel /*: Socket */
  http /*: Server */
  https /*: Server */

  async init() {
    initProm()

    this.http = net.createServer({}, this.connectionHandler('http'))
    this.http.on('error', this.serverErrorHandler)

    this.https = net.createServer({}, this.connectionHandler('https'))
    this.https.on('error', this.serverErrorHandler)

    this.client = new Client()
    const spec = await this.client.backend.http({ method: 'GET', pathname: '/openapi/v2' })
    this.client._addSpec(spec.body)

    await this.fetchIngresses()
    await this.watchForIngressChanges()

    this.http.listen(AGENT_HTTP_LISTEN_PORT, () => {
      this.https.listen(AGENT_HTTPS_LISTEN_PORT, () => {
        logger.info('kubesail-agent ready!', {
          namespace: this.namespace,
          AGENT_HTTP_LISTEN_PORT,
          AGENT_HTTPS_LISTEN_PORT
        })
      })
    })
  }

  // List ingresses
  async fetchIngresses() {
    const ingresses = await this.client.apis['networking.k8s.io'].v1beta1.ingress.get()

    for (const ingress of ingresses.body.items) {
      this.addIngress(ingress)
    }
  }

  // Setup watch for ingresses
  async watchForIngressChanges() {
    if (!this.client) throw new Error('Unable to establish Kube API connection')

    const stream = await this.client.apis[
      'networking.k8s.io'
    ].v1beta1.watch.ingress.getObjectStream()

    stream.on('error', err => {
      logger.error('watchForIngressChanges() stream error', { errMsg: err.message })
      this.watchForIngressChanges()
    })
    stream.on('disconnect', () => {
      logger.info('watchForIngressChanges() stream disconnect', {})
      this.watchForIngressChanges()
    })

    stream.on('data', async event => {
      if (event.type === 'ADDED' || event.type === 'MODIFIED') {
        this.addIngress(event.object)
      } else if (event.type === 'DELETED') {
        this.removeIngress(event.object)
      }
    })
  }

  addIngress(ingress /*: Object */) {
    const exists = this.ingresses.find(
      i =>
        i.metadata.namespace === ingress.metadata.namespace &&
        i.metadata.name === ingress.metadata.name
    )
    if (!exists) {
      this.ingresses.push(ingress)
      watchedIngresses.inc()
    }
  }

  removeIngress(ingress /*: Object */) {
    const filtered = this.ingresses.filter(
      i =>
        i.metadata.namespace !== ingress.metadata.namespace &&
        i.metadata.name !== ingress.metadata.name
    )
    if (filtered.length < this.ingresses) {
      this.ingresses = filtered
      watchedIngresses.dec()
    }
  }

  // connect to service
  connectToService() {
    // Connect to kubesail api
  }

  // On new tcp request from gateway-tunnel, look at known ingresses, pass to backend if exists
  requestHandler() {
    // Look at SNI header or Host header
    // Forward to ingress if exists/matches
  }

  serverErrorHandler(error /*: Error */) {
    throw error
  }

  connectionHandler(http /*: string */ = 'http') {
    return (connection /*: Object */) => {
      const httpBuffer = []
      connection.on('data', data => {
        if (http === 'http') httpBuffer.push(data)
        else console.log('sni', sni(data))
      })
      connection.on('end', function() {
        if (http === 'http') {
          const request = httpHeaders(Buffer.concat(httpBuffer))
          if (request && request.headers && request.headers.host) {
            console.log('Connecting socket')
          } else {
            connection.end()
          }
        }
      })
    }
  }
}

module.exports = KsAgent
