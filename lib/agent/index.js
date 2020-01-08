// @flow

/* flow-include
export type KsAgentConfig = {
  kubeapiEndpoint?: string,
  namespace?: string|Array<string>
}
*/

const fs = require('fs')
const { Client } = require('kubernetes-client')
const logger = require('../shared/logger')
const { prom, initProm } = require('../shared/prom')

const watchedIngresses = new prom.Gauge({
  name: 'watched_ingresses',
  help: 'Number of ingresses the Agent currently sees',
  registers: [prom.register]
})

module.exports = class KsAgent {
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

  async init() {
    initProm()
    this.client = new Client()
    const spec = await this.client.backend.http({ method: 'GET', pathname: '/openapi/v2' })
    this.client._addSpec(spec.body)

    logger.info('kubesail-agent ready!', { namespace: this.namespace })

    this.fetchIngresses()
    this.watchForIngressChanges()
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
}
