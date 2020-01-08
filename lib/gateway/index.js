// @flow

/* flow-include
export type KsGatewayConfig = {}
*/

const logger = require('../shared/logger')
const Redis = require('./redis')
const { _prom, initProm } = require('../shared/prom')

class KsGateway {
  // constructor(config /*: KsGatewayConfig */) {}
  init() {
    initProm()

    this.redis = Redis('CONNECTIONS')
    this.redisSub = Redis('CONNECTIONS', true)

    this.redisSub.on('message', function(event, payload) {
      logger.info('Gateway got published message:', { event, payload })
    })
  }
}

module.exports = KsGateway
