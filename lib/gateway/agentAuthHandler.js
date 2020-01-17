// @flow

const https = require('https')

const Redis = require('./redis')
const logger = require('../shared/logger')
const { KUBESAIL_API_SECRET } = require('../shared/config')

const redis = Redis('CACHE')

module.exports = function agentAuthHandler(
  socket /*: Socket */
) /*: false|{ validDomains: Array<string>, clusterAddress: string } */ {
  const agentToken = socket.handshake.query.token
  logger.debug('agentAuthHandler', { agentToken })

  // TODO: Validate authentication with the KubeSail API
  return {
    validDomains: ['home.test.users.kubesail.com', 'test-qotm.example.com'],
    clusterAddress: 'https://home.test.users.kubesail.com'
  }
}
