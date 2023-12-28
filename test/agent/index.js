// @flow

const http = require('node:http')
// $FlowIssue
// const { expect } = require('chai')

const { KUBESAIL_AGENT_HTTP_LISTEN_PORT } = require('../../lib/shared/config')

const httpReqOpts = { hostname: '127.0.0.1', port: KUBESAIL_AGENT_HTTP_LISTEN_PORT, method: 'GET' }

const describe = global.describe
const it = global.it

describe('Agent tests', function () {
  describe('HTTP Tunnel handling', function () {
    it('Currently routes the test endpoint', async function () {
      const req = http.request(httpReqOpts, res => {
        res.on('data', d => {
          process.stdout.write(d)
        })
      })

      req.on('error', error => {
        console.error(error)
      })
      req.end()
    })
  })
})
