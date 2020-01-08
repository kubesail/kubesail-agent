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

module.exports = class KsAgent {
  constructor(config /*: KsAgentConfig */) {
    this.config = config
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

  async init() {
    this.client = new Client({ version: '1.13' })
    const spec = await this.client.backend.http({ method: 'GET', pathname: '/openapi/v2' })
    this.client._addSpec(spec.body)

    logger.info('kubesail-agent ready!', { namespace: this.namespace })

    this.watchForIngressChanges()
  }

  // List ingresses

  // Setup watch for ingresses
  async watchForIngressChanges() {
    if (!this.client) throw new Error('Unable to establish Kube API connection')

    const stream = await this.client.apis[
      'networking.k8s.io'
    ].v1beta1.watch.ingress.getObjectStream()

    stream.on('error', err => {
      logger.error('watchForIngressChanges() stream error', { errMsg: err.message, clusterAddress })
      this.watchForIngressChanges()
    })
    stream.on('disconnect', () => {
      logger.info('watchForIngressChanges() stream disconnect', { clusterAddress })
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

  addIngress(ingress /*: Object */) {}

  removeIngress(ingress /*: Object */) {}

  // connect to service
  connectToService() {}

  // On new tcp request from gateway-tunnel, look at known ingresses, pass to backend if exists
}
