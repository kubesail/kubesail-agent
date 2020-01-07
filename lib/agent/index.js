// @flow

/* flow-include
export type KsAgentConfig = {
  kubeapiEndpoint?: string,
  namespace?: string|Array<string>
}
*/

const { Client } = require('kubernetes-client')
const logger = require('../shared/logger')

module.exports = class KsAgent {
  constructor(config /*: KsAgentConfig */) {
    this.config = config
  }

  client /*: Client */

  init() {
    logger.info('kubesail-agent ready!')
    this.client = new Client({ version: '1.13' })
    // Get k8s client

    setInterval(() => {
      console.log('Keep alive!')
    }, 1000)
  }

  // List ingresses

  // Setup watch for ingresses

  // connect to service
  connectToService() {}

  // On new tcp request from gateway-tunnel, look at known ingresses, pass to backend if exists
}
