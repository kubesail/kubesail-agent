// @flow

const prom = require('prom-client')
const express = require('express')
const { METRICS_LISTEN_PORT } = require('./config')

const metricsServer = express()
prom.collectDefaultMetrics({ timeout: 5000 })

let metricsOnline = false
function initProm(metricsPort /*: number|void */ = METRICS_LISTEN_PORT) {
  if (metricsOnline) return
  else metricsOnline = true

  metricsServer.get('/metrics', (req /*: express$Request */, res /*: express$Response */) => {
    res.set('Content-Type', prom.register.contentType)
    res.end(prom.register.metrics())
  })

  metricsServer.listen(metricsPort)
}

const bandwidthRecv = new prom.Gauge({
  name: `kubesail_gateway_bandwidth_recv`,
  help: 'kubesail_gateway_bandwidth_recv_help',
  labelNames: ['agentKey']
})
const bandwidthSent = new prom.Gauge({
  name: `kubesail_gateway_bandwidth_sent`,
  help: 'kubesail_gateway_bandwidth_sent_help',
  labelNames: ['agentKey']
})

module.exports = { initProm, prom, bandwidthRecv, bandwidthSent }
