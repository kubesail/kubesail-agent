// @flow

/* flow-include
export type KsGatewayConfig = {}
*/

const https = require('https')
const fs = require('fs')
const socketIO = require('socket.io')
const socketIoRedis = require('socket.io-redis')

const logger = require('../shared/logger')
const { prom, initProm } = require('../shared/prom')
const { sampleArray } = require('../shared/node')
const {
  TLS_KEY_PATH,
  TLS_CERT_PATH,
  TLS_CHAIN_PATH,
  REDIS_SERVERS,
  GATEWAY_AGENT_LISTEN_PORT
} = require('../shared/config')

let ca
if (TLS_CHAIN_PATH && fs.existsSync(TLS_CHAIN_PATH)) ca = TLS_CHAIN_PATH // eslint-disable-line

class KsGateway {
  agentRegistrationServer = https.createServer(
    {
      key: fs.readFileSync(TLS_KEY_PATH), // eslint-disable-line
      cert: fs.readFileSync(TLS_CERT_PATH), // eslint-disable-line
      ca: ca,
      honorCipherOrder: true
    },
    (req, res) => {
      console.log('Recieved request on agent-server')
      res.writeHead(200)
      res.end('OK')
    }
  )

  webSocketServer = socketIO(this.agentRegistrationServer, {
    handlePreflightRequest: function(req, res) {
      var headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true
      }
      res.writeHead(200, headers)
      res.end()
    },
    origins: '*:*',
    allowRequest: function(req, next) {
      next(null, true)
    }
  })

  init() {
    const redisAdapter = socketIoRedis(sampleArray(REDIS_SERVERS))
    this.webSocketServer.adapter(redisAdapter)

    redisAdapter.pubClient.on('error', err => {
      throw err
    })
    redisAdapter.subClient.on('error', err => {
      throw err
    })

    initProm()
    this.agentRegistrationServer.listen(GATEWAY_AGENT_LISTEN_PORT, () => {
      this.gatewayReady = true
      logger.info('kubesail-gateway ready!', {
        NODE_ENV: process.env.NODE_ENV,
        GATEWAY_AGENT_LISTEN_PORT
      })
    })
  }
}

module.exports = KsGateway
