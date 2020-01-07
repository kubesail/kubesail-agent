// @flow

/* flow-include
export type KsAgentConfig = {
  kubeapiEndpoint?: string,
  namespace?: string|Array<string>
}
*/

const Client = require('kubernetes-client')

module.exports = class KsAgent {
  constructor(config /*: KsAgentConfig */) {
    this.config = config
  }

  client /*: Client */

  init() {
    this.client = new Client({ version: '1.13' })
    // /run/secrets/kubernetes.io/serviceaccount/namespace
    // Get k8s client
  }

  // connect to service
  connectToService() {}

  //
}
