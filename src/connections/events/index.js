const assert = require('assert')
const cloudevents = require('cloudevents-sdk/v03')
const ld = require('lodash')

const sources = {
  nats: require('./nats'),
  local: require('./local')
}

const defaultConfig = {
  version: 'v1',
  group: 'kourier.io',
  timeout: 500,
  namespace: 'default',
  source: 'local'
}

class Events {
  constructor(name, config = {}, instances = {}) {
    this.config = ld.merge(defaultConfig, config)
    this.logger = instances.logger || console
    this.sourceName = this.config.source
    this.name = name

    assert(this.name)
    assert(this.sourceName)

    this.group = this.config.group
      .split('.')
      .reverse()
      .join('.')

    if (!sources[this.sourceName]) {
      throw new Error(`event source '${this.sourceName} is not found`)
    }
    const sourceConfig = this.config[this.sourceName] || {}
    this.source = new sources[this.sourceName](sourceConfig)
    this.subscriptions = {}
  }

  async connect() {
    await this.source.connect()
    this.logger.info(`Connected to event source ${this.sourceName}`)
  }

  // subscribe to events produced by this receiver
  // if field is empty - subscribed to all service events
  async subscribe(subscriptionID, resourcename, resourcetype, controllername, handler) {
    if (this.subscriptions[subscriptionID]) {
      throw new Error(`unable to subscribe - subscription ${subscriptionID} already exists`)
    }
    const topic = this.generateTopicName(resourcename, resourcetype, controllername)
    await this.source.subscribe(subscriptionID, topic, handler)
    this.logger.info(`subscribed to "${topic}" as "${subscriptionID}"`)
    // this.subscriptions[id] = { handler }
  }

  async unsubscribe(subscriptionID) {
    const subscription = this.subscriptions[subscriptionID]
    if (!subscription) {
      throw new Error(`unable to unsubscribe - subscription ${subscriptionID} is not found`)
    }
    await this.source.unsubscribe(subscriptionID)
  }

  // publish cloudevent from controller name
  async publish(resourcename, resourcetype, data) {
    const topic = this.generateTopicName(resourcename, resourcetype)
    const event = cloudevents
      .event()
      .type(topic)
      .source([this.config.namespace, this.name, resourcetype, resourcename].join('/'))
      .time(new Date())
      .data(data)
      .contenttype('application/json')
      .format()
    await this.source.publish(topic, event)
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
