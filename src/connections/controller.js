const assert = require('assert')
const grpc = require('@grpc/grpc-js')
const BB = require('bluebird')
const ld = require('lodash')
const { loadProto } = require('@kourier.io/proto')

const defaultConfig = {
  proto: undefined,
  host: 'localhost',
  port: '50051',
  timeout: 500
}

class Controller {
  constructor(name, config = {}, instances = {}) {
    this.name = name
    this.logger = instances.logger || console
    this.config = ld.merge(defaultConfig, config)

    assert(this.config.proto)
    assert(name)

    const KourierService = loadProto()
    this.serverAddr = `${this.config.host}:${this.config.port}`
    this.client = new KourierService(this.serverAddr, grpc.credentials.createInsecure())

    for (let name of Object.keys(KourierService.service)) {
      this.client[`${name}Async`] = BB.promisify(this.client[name], { context: this.client })
    }
  }

  async connect() {
    const { timeout } = this.config
    const controllerConfig = await this.client.HandshakeAsync({}).timeout(timeout)
    assert.equal(controllerConfig.name, this.name, 'controller provided invalid name')

    this.logger.info(`Connected to grpc://${this.serverAddr}`)
  }

  startEventStream() {
    const stream = this.client.StartStream()
    return stream
  }

  async pushConfigUpdate(configName, spectype, eventtype, spec) {
    const { timeout } = this.config
    const request = {
      name: configName,
      spectype: spectype.toUpperCase(),
      eventtype,
      spec: Buffer.from(JSON.stringify(spec))
    }
    const res = await this.client.ConfigUpdateAsync(request).timeout(timeout)
    assert.equal(res.result, 'OK')
  }
}

module.exports = { Controller }
