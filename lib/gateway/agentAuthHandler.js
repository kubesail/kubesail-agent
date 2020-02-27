// @flow

const https = require('https')
/* flow-include
const net = require('net')
*/

// const Redis = require('./redis')
const logger = require('../shared/logger')
const addSocketMapping = require('./addSocketMapping')
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

  logger.debug('agentAuthHandler got socket from', { agentKey, username })

  const postData = JSON.stringify({
    username,
    agentKey,
    agentSecret,
    gatewaySecret: KUBESAIL_API_SECRET,
    gatewayAddress: GATEWAY_ADDRESS
  })

  const options = {
    hostname: KubeSailApiTarget,
    headers: { 'Content-Type': 'application/json' },
    port: KubeSailApiPort,
    method: 'POST'
  }

  if (process.env.NODE_ENV === 'development') {
    options.insecure = true
    options.rejectUnauthorized = false
  }

  socket.on('config-response', ({ backend }) => {
    console.log('got config-response')
    const req = https.request({ ...options, path: '/agent/config' }, res => {
      logger.info('agent config-response from api', { statusCode: res.statusCode })
    })
    req.write(
      JSON.stringify({ backend, agentKey, agentSecret, gatewaySecret: KUBESAIL_API_SECRET })
    )
    req.end()
  })

  const req = https.request({ ...options, path: '/agent/register' }, res => {
    // TODO: Validate KUBESAIL_API_SECRET!!!
    if (res.statusCode === AGENT_REGISTER_VALID) {
      logger.info('agent register success')

      let buff = ''
      res.on('data', chunk => (buff = buff + chunk))
      res.on('end', () => {
        const { validDomains, clusterAddress } = JSON.parse(buff)
        logger.info('Registered agent is valid, sending agentData!', {
          validDomains,
          clusterAddress
        })
        socket.emit('agentData', { validDomains, clusterAddress })
        addSocketMapping(
          socket,
          [clusterAddress, validDomains],
          this.localSocketMapping,
          this.localSocketReverseMapping
        )
      })

      socket.join(agentKey + '|' + agentSecret)
    } else if (res.statusCode === AGENT_REGISTER_PENDING) {
    } else {
      logger.debug('Disconnected agent due to invalid agentAuthHandler reply' + res.statusCode)
      socket.disconnect()
    }
  })

  req.on('error', e => {
    console.log('Got error registering')
    console.error(e)
  })

  req.write(postData)
  req.end()

  socket.on('disconnect', msg => {
    const domains = this.localSocketReverseMapping[socket.id]
    if (!domains) {
      return
    }

    logger.debug('Socket disconnected, cleaning up', { socketId: socket.id, domains })
    for (let i = 0; i < domains.length; i++) {
      const host = domains[i]
      delete this.localSocketMapping[host]
    }
    delete this.localSocketReverseMapping[socket.id]
  })
}
