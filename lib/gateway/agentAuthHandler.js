// @flow

const https = require('https')
/* flow-include
const net = require('net')
*/

// const Redis = require('./redis')
// const logger = require('../shared/logger')
const { KUBESAIL_API_SECRET, KUBESAIL_API_TARGET, GATEWAY_ADDRESS } = require('../shared/config')

const [KubeSailApiTarget, KubeSailApiPort] = KUBESAIL_API_TARGET.split(':')

// const redis = Redis('CACHE')

module.exports = function agentAuthHandler(
  socket /*: net.Socket */
) /*: false|{ validDomains: Array<string>, clusterAddress: string } */ {
  const agentKey = socket.handshake.query.key
  const agentSecret = socket.handshake.query.secret

  const postData = JSON.stringify({
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
    console.log('statusCode:', res.statusCode)
    console.log('headers:', res.headers)

    res.on('data', d => {
      process.stdout.write(d)
    })
  })

  req.on('error', e => {
    console.log('Got error registering')
    console.error(e)
  })

  req.write(postData)
  req.end()

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
