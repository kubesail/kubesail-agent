// @flow

const https = require('https')
/* flow-include
const net = require('net')
*/

// const Redis = require('./redis')
const { isFQDN } = require('validator')
const logger = require('../shared/logger')
const {
  KUBESAIL_API_SECRET,
  KUBESAIL_API_TARGET,
  GATEWAY_ADDRESS,
  ALWAYS_VALID_DOMAINS
} = require('../shared/config')

const [KubeSailApiTarget, KubeSailApiPort] = KUBESAIL_API_TARGET.split(':')

// const redis = Redis('CACHE')
const AGENT_REGISTER_VALID = 200
const AGENT_REGISTER_PENDING = 202

module.exports = async function agentAuthHandler(
  socket /*: Socket */
) /*: false|{ validDomains: Array<string>, clusterAddress: string } */ {
  const agentKey = socket.handshake.query.key
  const agentSecret = socket.handshake.query.secret
  const username = socket.handshake.query.username

  logger.silly('Setting socket id mapping:', {
    socketId: socket.id,
    gatewayAddress: process.env.GATEWAY_INTERNAL_ADDRESS
  })
  await this.redis.set(socket.id, process.env.GATEWAY_INTERNAL_ADDRESS)

  const addSocketMapping = (socket /*: Socket */, validDomains /*: Array<string> */) => {
    for (let i = 0; i < validDomains.length; i++) {
      const host = validDomains[i]
      if (host && isFQDN(host)) {
        socket.join(host)
        this.localSocketMapping[host] = socket
        if (this.localSocketReverseMapping[socket.id]) {
          this.localSocketReverseMapping[socket.id].push(host)
        } else {
          this.localSocketReverseMapping[socket.id] = [host]
        }
      } else {
        throw new Error(
          `addSocketMapping cannot add non FQDN as a mapped socket! domain: "${host}"`
        )
      }
    }
  }

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
    const req = https.request({ ...options, path: '/agent/config' }, res => {
      logger.info('agent config-response from api', { statusCode: res.statusCode })
    })
    req.write(
      JSON.stringify({ backend, agentKey, agentSecret, gatewaySecret: KUBESAIL_API_SECRET })
    )
    req.end()
  })

  const req = https.request({ ...options, path: '/agent/register' }, res => {
    if (res.statusCode === AGENT_REGISTER_VALID) {
      let buff = ''
      res.on('data', chunk => (buff = buff + chunk))
      res.on('end', () => {
        const parsed = JSON.parse(buff)
        const clusterAddress = parsed.clusterAddress
        const validDomains = parsed.validDomains.concat(ALWAYS_VALID_DOMAINS).filter(Boolean)
        logger.info('Agent registered! Sending configuration', {
          agentKey,
          validDomains,
          clusterAddress
        })
        socket.join(agentKey + '|' + agentSecret)
        addSocketMapping(socket, [clusterAddress, ...validDomains])
        socket.emit('agentData', { validDomains, clusterAddress })
      })
    } else if (res.statusCode === AGENT_REGISTER_PENDING) {
    } else {
      logger.debug('Disconnected agent due to invalid agentAuthHandler reply' + res.statusCode)
      socket.disconnect()
    }
  })

  req.on('error', e => {
    logger.error('Gateway failed to register agent with KubeSail api!', {
      errMsg: e.message,
      code: e.code,
      type: e.type
    })
    // TODO: Ask the agent to retry in a backoff amount of time
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
