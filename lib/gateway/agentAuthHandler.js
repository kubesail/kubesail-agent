// @flow

const https = require('https')
/* flow-include
const net = require('net')
*/

// const Redis = require('./redis')
const logger = require('../shared/logger')
const { KUBESAIL_API_SECRET, KUBESAIL_API_TARGET, GATEWAY_ADDRESS } = require('../shared/config')

const [KubeSailApiTarget, KubeSailApiPort] = KUBESAIL_API_TARGET.split(':')

// const redis = Redis('CACHE')
const AGENT_REGISTER_VALID = 200
const AGENT_REGISTER_PENDING = 202

module.exports = function agentAuthHandler(
  socket /*: net.Socket */
) /*: false|{ validDomains: Array<string>, clusterAddress: string } */ {
  const agentKey = socket.handshake.query.key
  const agentSecret = socket.handshake.query.secret
  const username = socket.handshake.query.username

  const postData = JSON.stringify({
    username,
    agentKey,
    agentSecret,
    gatewaySecret: KUBESAIL_API_SECRET,
    gatewayAddress: GATEWAY_ADDRESS
  })

  const options = {
    hostname: KubeSailApiTarget,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': postData.length
    },
    port: KubeSailApiPort,
    path: '/agent/register',
    method: 'POST'
  }

  if (process.env.NODE_ENV === 'development') {
    options.insecure = true
    options.rejectUnauthorized = false
  }

  const req = https.request(options, res => {
    if (res.statusCode === AGENT_REGISTER_VALID || res.statusCode === AGENT_REGISTER_PENDING) {
      // TODO: Validate KUBESAIL_API_SECRET!!!

      socket.join(agentKey + '|' + agentSecret)

      socket.on('config-response', () => {
        // Save agent config / reply to API here with config!
      })
    } else {
      logger.debug('Disconnected agent due to invalid agentAuthHandler reply')
      socket.disconnect()
    }
  })

  req.on('error', e => {
    console.log('Got error registering')
    console.error(e)
  })

  req.write(postData)
  req.end()

  return {
    validDomains: ['home.test.users.kubesail.com', 'test-qotm.example.com'],
    clusterAddress: 'https://home.test.users.kubesail.com'
  }
}
