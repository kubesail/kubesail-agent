// @flow

/* flow-include
export type KsGatewayConfig = {}
*/

const logger = require('../shared/logger')
const { prom, initProm } = require('../shared/prom')

class KsGateway {
  // constructor(config /*: KsGatewayConfig */) {}
  init() {
    initProm()
  }
}

module.exports = KsGateway
