import { Context, Channel, Session, User, Argv } from 'koishi-core'
import { sleep, segment, template, makeArray, Time } from 'koishi-utils'

template.set('common', {
  'expect-text': '请输入要发送的文本。',
  'expect-command': '请输入要触发的指令。',
  'expect-context': '请提供新的上下文。',
  'invalid-private-member': '无法在私聊上下文使用 --member 选项。',
  'feedback-receive': '收到来自 {0} 的反馈信息：\n{1}',
  'feedback-success': '反馈信息发送成功！',
  // eslint-disable-next-line quote-props
  'relay': '{0}: {1}',
})

interface RelayOptions {
  source: string
  destination: string
  selfId?: string
  lifespan?: number
}

export interface SenderConfig {
  echo?: boolean
  broadcast?: boolean
  contextify?: boolean
  operator?: string | string[]
  relay?: RelayOptions | RelayOptions[]
}

export default function apply(ctx: Context, config: SenderConfig = {}) {
  const dbctx = ctx.select('database')

  config.echo !== false && ctx
    .command('common/echo <message:text>', '向当前上下文发送消息', { authority: 2 })
    .option('anonymous', '-a  匿名发送消息', { authority: 3 })
    .option('forceAnonymous', '-A  匿名发送消息', { authority: 3 })
    .option('escape', '-e  发送转义消息', { authority: 3 })
    .action(async ({ options }, message) => {
      if (!message) return template('common.expect-text')

      if (options.escape) {
        message = segment.unescape(message)
      }

      if (options.forceAnonymous) {
        message = segment('anonymous') + message
      } else if (options.anonymous) {
        message = segment('anonymous', { ignore: true }) + message
      }

      return message
    })

  const operator = makeArray(config.operator)
  if (operator.length) {
    type FeedbackData = [sid: string, channelId: string]
    const feedbacks: Record<number, FeedbackData> = {}

    ctx.command('common/feedback <message:text>', '发送反馈信息给作者')
      .userFields(['name', 'id'])
      .action(async ({ session }, text) => {
        if (!text) return template('common.expect-text')
        const { username: name, userId } = session
        const nickname = name === '' + userId ? userId : `${name} (${userId})`
        const message = template('common.feedback-receive', nickname, text)
        const delay = ctx.app.options.delay.broadcast
        const data: FeedbackData = [session.sid, session.channelId]
        for (let index = 0; index < operator.length; ++index) {
          if (index && delay) await sleep(delay)
          const [platform, userId] = Argv.parsePid(operator[index])
          const id = await ctx.getBot(platform).sendPrivateMessage(userId, message)
          feedbacks[id] = data
        }
        return template('common.feedback-success')
      })

    ctx.middleware((session, next) => {
      const { quote, parsed } = session
      if (!parsed.content || !quote) return next()
      const data = feedbacks[quote.messageId]
      if (!data) return next()
      return ctx.bots[data[0]].sendMessage(data[1], parsed.content)
    })
  }

  const relay = makeArray(config.relay)
  const relayMap: Record<string, RelayOptions> = {}

  async function sendRelay(session: Session, { destination, selfId, lifespan = Time.hour }: RelayOptions) {
    const [platform, channelId] = Argv.parsePid(destination)
    const bot = ctx.getBot(platform, selfId)
    if (!session.parsed.content) return
    const content = template('common.relay', session.username, session.parsed.content)
    const id = await bot.sendMessage(channelId, content)
    relayMap[id] = { source: destination, destination: session.cid, selfId: session.selfId, lifespan }
    setTimeout(() => delete relayMap[id], lifespan)
  }

  ctx.middleware((session, next) => {
    const { quote = {} } = session
    const data = relayMap[quote.messageId]
    if (data) return sendRelay(session, data)
    const tasks: Promise<void>[] = []
    for (const options of relay) {
      if (session.cid !== options.source) continue
      tasks.push(sendRelay(session, options).catch())
    }
    tasks.push(next())
    return Promise.all(tasks)
  })

  config.broadcast !== false && dbctx
    .command('common/broadcast <message:text>', '全服广播', { authority: 4 })
    .option('forced', '-f  无视 silent 标签进行广播')
    .option('only', '-o  仅向当前 Bot 负责的群进行广播')
    .action(async ({ options, session }, message) => {
      if (!message) return template('common.expect-text')
      if (!options.only) {
        await ctx.broadcast(message, options.forced)
        return
      }

      const fields: ('id' | 'flag')[] = ['id']
      if (!options.forced) fields.push('flag')
      let groups = await ctx.database.getAssignedChannels(fields, { [session.platform]: [session.selfId] })
      if (!options.forced) {
        groups = groups.filter(g => !(g.flag & Channel.Flag.silent))
      }
      await session.bot.broadcast(groups.map(g => g.id.slice(session.platform['length'] + 1)), message)
    })

  config.contextify !== false && dbctx
    .command('common/contextify <message:text>', '在特定上下文中触发指令', { authority: 3 })
    .alias('ctxf')
    .userFields(['authority'])
    .option('user', '-u [id:user]  使用用户私聊上下文')
    .option('member', '-m [id:user]  使用当前频道成员上下文')
    .option('channel', '-c [id:channel]  使用群聊上下文')
    .action(async ({ session, options }, message) => {
      if (!message) return template('common.expect-command')

      if (options.member) {
        if (session.subtype === 'private') {
          return template('common.invalid-private-member')
        }
        options.channel = session.cid
        options.user = options.member
      }

      if (!options.user && !options.channel) {
        return template('common.expect-context')
      }

      const sess = new Session(ctx.app, session)
      sess.send = session.send.bind(session)
      sess.sendQueued = session.sendQueued.bind(session)

      if (!options.channel) {
        sess.subtype = 'private'
      } else if (options.channel !== session.cid) {
        sess.channelId = Argv.parsePid(options.channel)[1]
        sess.cid = `${sess.platform}:${sess.channelId}`
        sess.subtype = 'group'
        await sess.observeChannel(Channel.fields)
      } else {
        sess.channel = session.channel
      }

      if (options.user && options.user !== session.uid) {
        sess.userId = sess.author.userId = Argv.parsePid(options.user)[1]
        sess.uid = `${sess.platform}:${sess.userId}`
        const user = await sess.observeUser(User.fields)
        if (session.user.authority <= user.authority) {
          return template('internal.low-authority')
        }
      } else {
        sess.user = session.user
      }

      if (options.member) {
        const info = await session.bot.getGroupMember?.(sess.groupId, sess.userId).catch(() => ({}))
        Object.assign(sess.author, info)
      } else if (options.user) {
        const info = await session.bot.getUser?.(sess.userId).catch(() => ({}))
        Object.assign(sess.author, info)
      }

      await sess.execute(message)
    })
}
