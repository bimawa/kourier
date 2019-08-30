const nats = require('nats')
const BB = require('bluebird')
const assert = require('assert')
const cloudevents = require('cloudevents-sdk/v03')
const ld = require('lodash')

const defaultConfig = {
  version: 'v1',
  group: 'kourier.io',
  timeout: 500,
  namespace: 'default',
  nats: {
    url: 'nats://localhost:4222'
  }
}

class Events {
  constructor(name, config = {}, instances = {}) {
    this.config = ld.merge(defaultConfig, config)
    this.logger = instances.logger || console

    this.name = name
    assert(this.name)

    this.group = this.config.group
      .split('.')
      .reverse()
      .join('.')
    this.subscriptions = {}
  }

  async connect() {
    const nc = nats.connect({ ...this.config.nats, json: true, name: this.name })

    return new BB.fromCallback(resolve => {
      const reject = err => {
        throw err
      }
      nc.on('error', reject)
      nc.on('connect', () => {
        nc.off('error', reject)
        this.nats = nc
        this.nats.on('error', err => {
          throw err
        })
        this.logger.info(`Connected to ${this.config.nats.url}`)
        resolve()
      })
    })
  }

  // subscribe to events produced by this receiver
  // if field is empty - subscribed to all service events
  subscribe(id, resourcename, resourcetype, controllername, handler) {
    // event.type
    const pattern = this.generateTopicName(resourcename, resourcetype, controllername)
    const opts = { queue: id }

    // if (this.subscriptions[pattern]) {
    //   return this.logger.error('already subscribed to', pattern)
    // }
    this.logger.info(`subscribed to "${pattern}" as "${id}"`)
    this.subscriptions[id] = this.nats.subscribe(pattern, opts, (json, replyTo, topic) => {
      // TODO: validate incoming event
      assert(json.source)
      assert(json.type)
      this.logger.info('event received', topic, json)
      return handler(json)
    })
  }

  unsubscribe(id, resourcename, resourcetype, controllername) {
    const pattern = this.generateTopicName(resourcename, resourcetype, controllername)
    if (!this.subscriptions[id]) {
      return this.logger.error('subscription does not found', pattern)
    }
    this.nats.unsubscribe(this.subscriptions[pattern])
    delete this.subscriptions[pattern]
  }

  // publish cloudevent from controller name
  async publish(resourcename, resourcetype, data) {
    const eventType = this.generateTopicName(resourcename, resourcetype)
    const event = cloudevents
      .event()
      .type(eventType)
      .source([this.config.namespace, this.name, resourcetype, resourcename].join('/'))
      .time(new Date())
      .data(data)
      .contenttype('application/json')
      .format()

    this.logger.info('event published', event.type, event)
    return new BB.fromCallback(resolve => this.nats.publish(event.type, event, resolve)).timeout(
      this.config.timeout
    )
  }

  // io.kourier.{namespace}.{controllername}.{resourcetype}.{resourcename}.v1
  generateTopicName(resourcename, resourcetype, controllername = this.name) {
    assert(resourcename)
    assert(resourcetype, 'generateTopicName - expect .producer')
    return [
      this.group,
      this.config.namespace,
      controllername,
      resourcetype,
      resourcename,
      this.config.version
    ].join('.')
  }
}

module.exports = { Events }
