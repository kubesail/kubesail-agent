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

  // socket.on('config-response', () => {
  //   console.log('got non-namespaced config response')
  //   console.log('socket.room', socket.rooms)
  // })

  const ns = this.agentRegistrationSocketServer.of(agentKey + '|' + agentSecret)
  ns.on('config-response', config => {
    console.log('got config response')
    // res.writeHead(200)
    // res.end(config)
  })

  const req = https.request(options, res => {
    if (res.statusCode === AGENT_REGISTER_VALID || res.statusCode === AGENT_REGISTER_PENDING) {
      // TODO: Validate KUBESAIL_API_SECRET!!!

      socket.join(agentKey + '|' + agentSecret)

      if (res.statusCode === AGENT_REGISTER_VALID) {
        const agentData = {
          validDomains: ['home.test.users.kubesail.com', 'test-qotm.example.com'],
          clusterAddress: 'https://home.test.users.kubesail.com'
        }

        if (!agentData) return socket.disconnect()

        socket.emit('agentData', agentData)

        logger.debug('Agent connected', { agentData })
        for (let i = 0; i < agentData.validDomains.length; i++) {
          const domain = agentData.validDomains[i]
          this.localSocketMapping[domain] = socket
          if (this.localSocketReverseMapping[socket.id]) {
            this.localSocketReverseMapping[socket.id].push(domain)
          } else {
            this.localSocketReverseMapping[socket.id] = [domain]
          }
        }
      }
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
