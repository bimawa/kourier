const path = require('path')
const assert = require('assert')
const fs = require('fs')
const ld = require('lodash')
const yaml = require('js-yaml')
const Ajv = require('ajv')
const Jsonnet = require('@rbicker/jsonnet')

const { Events } = require('./connections/events')
const { Cluster } = require('./connections/cluster')
const { Controller } = require('./connections/controller')

const crdSpecifications = [
  requireYAML('../deploy/consumers.yml'),
  requireYAML('../deploy/producers.yml')
]

const ajv = new Ajv({
  allErrors: true,
  removeAdditional: true,
  useDefaults: true,
  coerceTypes: true
})

const defaultSchema = { type: 'object' }

const defaultConfig = {
  name: process.env.KOURIER_NAME,
  cluster: {},
  controller: {
    host: process.env.GRPC_HOST || 'localhost',
    port: process.env.GRPC_PORT || '50051'
  },
  events: {
    source: process.env.KOURIER_EVENTSOURCE || 'local',
    nats: {
      url: process.env.NATS_URL || 'nats://localhost:4222'
    },
    local: {
      //
    }
  }
}

class KourierProxy {
  constructor(config = {}) {
    this.config = ld.merge(defaultConfig, config)

    this.name = this.config.name
    assert(this.name, 'please specify KOURIER_NAME env')
    this.logger = console

    this.resources = { consumers: [], producers: [] }

    const instances = { logger: this.logger }
    this.cluster = new Cluster(this.name, this.config.cluster, instances)
    this.controller = new Controller(this.name, this.config.controller, instances)

    this.events = new Events(this.name, this.config.events, instances)
  }

  handleUncaughtError(err) {
    this.logger.error(err)
    process.exit()
  }

  // produce event from controller
  async emitControllerEvent(producerName, data) {
    const resource = this.resources.producers && this.resources.producers[producerName]
    if (!resource) {
      return this.logger.warn(`controller produce event '${producerName}' but no such CRD exists`)
    }
    if (!resource.validator(data)) {
      const err = new Error(
        `message validation failed: ${ajv.errorsText(resource.validator.errors)}`
      )
      throw err
    }
    let result = data
    data = applyJsonTransformation(data, resource.update)
    data = applyJsonTransformation(data, resource.replace, true)
    await this.events.publish(producerName, 'producer', result)
  }

  // send event from queue to controller
  async notifyCloudEvent(cloudevent) {
    // TODO: validate cloud event
    const [, controller, , producer] = cloudevent.source.split('/')
    const listen = `${controller}.${producer}`
    const resources = getListenConsumers(this.resources, listen)
    resources.forEach(resource => {
      const event = ld.cloneDeep(cloudevent)
      if (!resource.validator(event.data)) {
        const err = new Error(
          `message validation failed: ${ajv.errorsText(resource.validator.errors)}`
        )
        throw err
      }

      let data = event.data
      data = applyJsonTransformation(data, resource.update)
      data = applyJsonTransformation(data, resource.replace, true)
      event.data = data
      const value = Buffer.from(JSON.stringify(event))
      this.stream.write({ name: resource.name, value })
    })
  }

  // send notification to controller about CRD change
  async notifyConfigUpdate(crdEvent) {
    const { name } = crdEvent.object.metadata
    const { controller } = crdEvent.object.spec

    if (controller !== this.name) {
      return
    }

    const spectype = crdEvent.object.kind
    const eventtype = crdEvent.type
    const spec = crdEvent.object.spec

    await this.controller.pushConfigUpdate(name, spectype, eventtype, spec)

    // update internal state of resources
    this.resources[spectype] = this.resources[spectype] || {}

    // unique subscription id
    const id = [name, spectype].join('-')
    switch (eventtype) {
      case 'ADDED':
      case 'MODIFIED':
        // subscribe to specified event if subscription does not exist
        if (spectype === 'consumers' && eventtype === 'ADDED') {
          // start emitting cloud events
          assert(spec.listen)
          const [resource] = getListenConsumers(this.resources, spec.listen)
          if (!resource) {
            const [controllername, resourcename] = spec.listen.split('.')
            this.events.subscribe(
              id,
              resourcename,
              'producer',
              controllername,
              this.notifyCloudEvent.bind(this)
            )
          }
        }

        const validator = ajv.compile(spec.schema || defaultSchema)
        this.resources[spectype][name] = {
          validator,
          spec,
          name,
          update: parseJsonNetString(spec.update),
          replace: parseJsonNetString(spec.replace)
        }
        break
      case 'DELETED':
        if (spectype === 'consumers') {
          // unsubscribe from events
          this.events.unsubscribe(id)
        }
        delete this.resources[spectype][name]
        break
    }

    this.logger.info(`${crdEvent.type} ${crdEvent.object.kind} ${name}`)
  }

  async connect() {
    //
    await this.events.connect()
    await this.controller.connect()
    await this.cluster.connect()

    //
    crdSpecifications.forEach(spec => {
      this.cluster.listenCRDUpdate(spec, this.notifyConfigUpdate.bind(this))
    })

    //
    this.stream = this.controller.startEventStream()
    this.stream.on('error', err => {
      console.log('controller disconnected')
      // TODO: reconnect
      // - stop receiving events from the queue
      // - stop receiving events from the cluster
      // - try to reconnect
      // - on success continue receiving-emitting such events
      this.handleUncaughtError(err)
    })
    this.stream.on('end', () => this.handleUncaughtError(new Error('client stream is closed')))
    this.stream.on('data', async input => {
      const { name, data } = input
      await this.emitControllerEvent(name, JSON.parse(data))
    })

    this.logger.info(`Kourier proxy '${this.name}' started`)
  }
}

// return consumer with specified .spec.listen
function getListenConsumers(storage, listen) {
  return Object.values(storage.consumers).filter(item => {
    return item.spec.listen === listen
  })
}

function requireYAML(relativePath) {
  const fullPath = path.resolve(__dirname, relativePath)
  return yaml.safeLoad(fs.readFileSync(fullPath, 'utf8'))
}

function applyJsonTransformation(event, transformation, replace = true) {
  if (!transformation) {
    return event
  }
  const jsonnet = new Jsonnet()
  const strigifiedEvent = JSON.stringify(event, null, '  ')
  const code = [`local message = ${strigifiedEvent};`]
  code.push(replace ? `${transformation}` : `message ${transformation}`)
  return jsonnet.eval(code.join('\n'))
  // try {
  //   return jsonnet.eval(code)
  // } catch (err) {
  //   console.log('ERROR transforming:')
  //   console.log(err)
  //   console.log('code:')
  //   console.log(code)
  // }
}

// create parsed JSON string by replacing all newlines (https://yaml-multiline.info/)
function parseJsonNetString(code) {
  return code ? code.split('\\n').join('\n') : ''
}

module.exports = { KourierProxy }

if (require.main === module) {
  const proxy = new KourierProxy()

  proxy.connect().catch(err => {
    throw err
  })
}
