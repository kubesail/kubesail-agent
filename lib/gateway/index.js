// @flow

/* flow-include
export type KsGatewayConfig = {}
*/

const { Client } = require('kubernetes-client')
const logger = require('../shared/logger')
const Redis = require('./redis')
const redis = Redis('CONNECTIONS')

module.exports = class KsGateway {
  // constructor(config /*: KsGatewayConfig */) {}
  init() {
    console.log('KsGateway init()')
    redis.ping()
  }
}
