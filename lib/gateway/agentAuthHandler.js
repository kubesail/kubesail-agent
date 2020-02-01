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

  // 200 from API === Agent is registered and confirmed
  // 202 from API === Agent token is valid, awaiting user confirmation
  // 400 from API === Bad request / Unauthorized

  // On 202, wait for webhook, send message to agent asking for Kube config
  // Once agent replies with kube config, ping API

  // TODO: Validate authentication with the KubeSail API
  return {
    validDomains: ['home.test.users.kubesail.com', 'test-qotm.example.com'],
    clusterAddress: 'https://home.test.users.kubesail.com'
  }
}
