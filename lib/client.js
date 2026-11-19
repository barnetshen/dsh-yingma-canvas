// 小影马画布 · 浏览器半边
// 侧栏加一个「小影马画布」入口，主区域是插件自己的同源壳页（/yingma-canvas/，iframe）。
// 壳页里点「交给 Agent」时通过 postMessage 传一段草稿，这里开一个新对话并填进输入框，
// 再把画布作为右侧停靠栏的标签页放到对话旁边；停靠在对话旁边的画布则直接插进那个对话的输入框。
window.__ModuleLoader__.load({
  id: 'dsh-yingma-canvas',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const PANEL = 'yingma-canvas'
    const SRC = '/yingma-canvas/'

    // 侧栏图标：影马「无限画布」入口记号（两框对角 + 右上角 ✦）
    // 规格跟 DSH 系统图标（Icon*OutlineRegular）走：16 画布、1 线宽、字形落在 2–14，
    // 线宽按画布比例缩放，换成 24 画布或 2 线宽就会比旁边的系统图标又粗又大。
    const CANVAS_SPARK =
      'M12.5 2c.1 1.05.6 1.6 1.75 1.75-1.15.15-1.65.7-1.75 1.75-.1-1.05-.6-1.6-1.75-1.75 1.15-.15 1.65-.7 1.75-1.75Z'

    function CanvasIcon(props) {
      const size = (props && props.size) || 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          className: props && props.className,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1,
          'aria-hidden': true,
        },
        h('rect', { x: 2.25, y: 2.25, width: 5, height: 5, rx: 1 }),
        h('path', { d: 'M7.25 4.75h3v4' }),
        h('rect', { x: 8.75, y: 8.75, width: 5, height: 5, rx: 1 }),
        h('path', { d: CANVAS_SPARK, fill: 'currentColor', stroke: 'none' })
      )
    }

    // 右侧停靠栏里的画布标签页：对话在中间，画布在右边（可浮窗、可全屏）
    const TAB_ID = 'dsh-yingma-canvas/canvas'
    const TAB_KIND = 'yingma-canvas'
    // 每个会话输入框的插入接口：由挂在 conversation.input.left 的空组件登记
    const composers = new Map()

    function apply(ctx) {
      const frames = new Set()
      let scheme = null
      let sidebarRight = null

      const post = (frame, message) => {
        if (!frame || !frame.contentWindow) return
        try {
          frame.contentWindow.postMessage(message, location.origin)
        } catch {
          /* iframe 还没加载好 */
        }
      }

      const postScheme = (frame) => {
        if (scheme) post(frame, { type: 'yingma-canvas:scheme', scheme })
      }

      ctx.inject(['theme'], (c) => {
        const push = (snapshot) => {
          scheme = snapshot && snapshot.active ? snapshot.active.colorScheme : null
          frames.forEach(postScheme)
        }
        try {
          push(c.theme.getTheme())
        } catch {
          /* 主题服务还没就绪 */
        }
        c.on('theme/change', push)
      })

      // 往屏幕上那个会话的输入框插一段文字；做不到返回 false
      function insertIntoComposer(text) {
        const sessionId = sidebarRight && sidebarRight.mounted.getSnapshot()
        const actions = sessionId && composers.get(sessionId)
        if (!actions) return false
        try {
          const span = actions.captureInsertion()
          return actions.insertText((span.from > 0 ? '\n' : '') + text, span) !== false
        } catch {
          return false
        }
      }

      // 新会话出现在屏幕上后，把画布放到它右边
      function openCanvasBesideSession() {
        if (!sidebarRight) return
        const deadline = Date.now() + 8000
        const tryOpen = () => {
          if (!sidebarRight.mounted.getSnapshot()) return false
          try {
            sidebarRight.openTab(TAB_KIND, { revealIfOpened: true })
            return true
          } catch {
            return false // 会话的 store 还没建好，稍后再试
          }
        }
        const tick = () => {
          if (tryOpen() || Date.now() > deadline) return
          setTimeout(tick, 250)
        }
        setTimeout(tick, 0)
      }

      function startConversation(frame, prompt) {
        try {
          ctx.uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'replace' })
          openCanvasBesideSession()
        } catch (error) {
          post(frame, { type: 'yingma-canvas:start-failed', message: String((error && error.message) || error) })
        }
      }

      function useCanvasFrame(ref, docked) {
        React.useEffect(() => {
          const self = ref.current
          if (self) frames.add(self)

          function onMessage(event) {
            const frame = ref.current
            if (!frame || event.source !== frame.contentWindow) return
            if (event.origin !== location.origin) return
            const message = event.data
            if (!message || message.type !== 'yingma-canvas:start' || typeof message.prompt !== 'string') return
            // 停靠在会话旁边时，交给旁边这个对话：插进输入框，不另开会话
            if (docked && insertIntoComposer(message.prompt)) {
              post(frame, { type: 'yingma-canvas:inserted' })
              return
            }
            startConversation(frame, message.prompt)
          }

          addEventListener('message', onMessage)
          if (self) postScheme(self)
          return () => {
            removeEventListener('message', onMessage)
            frames.delete(self)
          }
        }, [])
      }

      function canvasFrame(ref, src) {
        return h('iframe', {
          ref,
          src,
          title: '小影马画布',
          allow: 'clipboard-read; clipboard-write; fullscreen',
          onLoad: (event) => postScheme(event.currentTarget),
          style: { width: '100%', height: '100%', border: 0, display: 'block', background: 'transparent' },
        })
      }

      function CanvasPanel() {
        const ref = React.useRef(null)
        useCanvasFrame(ref, false)
        return canvasFrame(ref, SRC)
      }

      function CanvasTab() {
        const ref = React.useRef(null)
        useCanvasFrame(ref, true)
        return canvasFrame(ref, SRC + '?dock=1')
      }

      // 不渲染任何东西，只把这个会话输入框的插入接口记下来
      function ComposerBridge(props) {
        const sessionId = props.sessionId
        const actions = props.inputActions
        React.useEffect(() => {
          if (!sessionId || !actions) return
          composers.set(sessionId, actions)
          return () => {
            if (composers.get(sessionId) === actions) composers.delete(sessionId)
          }
        }, [sessionId, actions])
        return null
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL, order: 8, label: () => '小影马画布' },
          CanvasIcon
        )
      )
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, CanvasPanel))

      // 老版本 DSH 没有右侧停靠栏：只保留侧栏入口
      ctx.inject(['sidebarRight', 'sidebarRightTabs'], (c) => {
        sidebarRight = c.sidebarRight
        c.effect(() => () => {
          sidebarRight = null
        })
        c.effect(() =>
          c.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'extension',
            keepMounted: true,
            title: () => '小影马画布',
            guide: [
              {
                id: 'canvas',
                order: 40,
                title: () => '小影马画布',
                description: () => '在对话旁边打开画布',
                icon: CanvasIcon,
              },
            ],
          })
        )
        c.slots.inject('sidebar.right.pane.tab', () =>
          c.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, CanvasTab)
        )
        c.slots.inject('conversation.input.left', () =>
          c.slots.register({ name: 'conversation.input.left', id: 'yingma-canvas-composer' }, ComposerBridge)
        )
      })
    }

    exports.isPlugin = true
    exports.inject = ['slots', 'uiWorkspace']
    exports.apply = apply
    return module.exports
  },
})
