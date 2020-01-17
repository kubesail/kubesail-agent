// @flow

// const https = require('https')
/* flow-include
const net = require('net')
*/

// const Redis = require('./redis')
// const logger = require('../shared/logger')
// const { KUBESAIL_API_SECRET } = require('../shared/config')

// const redis = Redis('CACHE')

module.exports = function agentAuthHandler(
  socket /*: net.Socket */
) /*: false|{ validDomains: Array<string>, clusterAddress: string } */ {
  // const agentToken = socket.handshake.query.token

  // TODO: Validate authentication with the KubeSail API
  return {
    validDomains: ['home.test.users.kubesail.com', 'test-qotm.example.com'],
    clusterAddress: 'https://home.test.users.kubesail.com'
  }
}
