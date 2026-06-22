import twemoji from '@twemoji/api'
import type {
  App,
  Editor,
  MarkdownPostProcessor,
  TFile,
  Workspace,
} from 'obsidian'
import {
  ItemView,
  MarkdownPreviewRenderer,
  MarkdownView,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
} from 'obsidian'
import React from 'react'
import ReactDOM from 'react-dom'

import EmojiToolbar from './ui/EmojiToolbar'

// emoji-mart 中文国际化（基于 @emoji-mart/data/i18n/zh.json）
import zhI18n from '@emoji-mart/data/i18n/zh.json'
const EMOJI_I18N = zhI18n

// ---- 保存的选区状态 ----

interface SavedSelection {
  type: 'editor' | 'inline-title' | 'rename-input' | 'contenteditable' | 'none'
  editor?: Editor
  cursorPos?: { line: number; ch: number }
  file?: TFile
  contentEl?: HTMLElement
  range?: Range
  inputEl?: HTMLInputElement | HTMLTextAreaElement
  selStart?: number
  selEnd?: number
}

// ---- 最后聚焦的输入元素追踪 ----

interface TrackedInput {
  element: HTMLInputElement | HTMLTextAreaElement | HTMLElement
  type: 'inline-title' | 'rename-input' | 'contenteditable'
  file?: TFile
  range?: Range
  selStart?: number
  selEnd?: number
  timestamp: number
}

// ---- 辅助函数 ----

function getActiveEditor(workspace: Workspace): Editor | undefined {
  const markdownView = workspace.getActiveViewOfType(MarkdownView)
  if (markdownView) {
    return markdownView.editor
  }
  const itemView = workspace.getActiveViewOfType(ItemView)
  if (itemView?.getViewType() === 'canvas') {
    return (itemView as any).canvas?.editor
  }
  return undefined
}

function detectInsertTarget(app: App, trackedInput: TrackedInput | null): SavedSelection {
  const activeEl = document.activeElement as HTMLElement

  // 1. 优先检查当前活跃元素
  if (activeEl) {
    // 内联标题（contenteditable div.inline-title）
    if (activeEl.classList.contains('inline-title') && activeEl.isContentEditable) {
      const file = app.workspace.getActiveFile()
      if (file) {
        const selection = window.getSelection()
        return {
          type: 'inline-title',
          file,
          contentEl: activeEl,
          range: selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : undefined,
        }
      }
    }

    // 文件重命名输入框
    if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) {
      if (!activeEl.closest('#emoji-modal')) {
        const fileEl = activeEl.closest('[data-path]')
        if (fileEl) {
          const filePath = fileEl.getAttribute('data-path')
          if (filePath) {
            const file = app.vault.getAbstractFileByPath(filePath)
            if (file instanceof TFile) {
              return {
                type: 'rename-input',
                file,
                inputEl: activeEl,
                selStart: activeEl.selectionStart ?? 0,
                selEnd: activeEl.selectionEnd ?? 0,
              }
            }
          }
        }
        // 普通输入框（非文件重命名）
        return {
          type: 'rename-input',
          inputEl: activeEl,
          selStart: activeEl.selectionStart ?? 0,
          selEnd: activeEl.selectionEnd ?? 0,
        }
      }
    }

    // 其他 contenteditable（排除 CodeMirror 编辑区内容）
    if (
      activeEl.isContentEditable &&
      !activeEl.closest('#emoji-modal') &&
      !activeEl.closest('.cm-content') &&
      !activeEl.classList.contains('inline-title')
    ) {
      const selection = window.getSelection()
      if (selection && selection.rangeCount > 0) {
        return {
          type: 'contenteditable',
          contentEl: activeEl,
          range: selection.getRangeAt(0).cloneRange(),
        }
      }
    }
  }

  // 2. 检查追踪到的最近输入元素（3 秒内有效）
  if (trackedInput && Date.now() - trackedInput.timestamp < 3000) {
    const el = trackedInput.element
    if (el.isConnected) {
      if (trackedInput.type === 'inline-title' && trackedInput.file) {
        return {
          type: 'inline-title',
          file: trackedInput.file,
          contentEl: el as HTMLElement,
          range: trackedInput.range,
        }
      }
      if (trackedInput.type === 'rename-input' && trackedInput.file) {
        return {
          type: 'rename-input',
          file: trackedInput.file,
          inputEl: el as HTMLInputElement,
          selStart: trackedInput.selStart ?? 0,
          selEnd: trackedInput.selEnd ?? 0,
        }
      }
      if (trackedInput.type === 'contenteditable') {
        return {
          type: 'contenteditable',
          contentEl: el as HTMLElement,
          range: trackedInput.range,
        }
      }
    }
  }

  // 3. 回退到编辑器
  const editor = getActiveEditor(app.workspace)
  if (editor) {
    return {
      type: 'editor',
      editor,
      cursorPos: editor.getCursor('from'),
    }
  }

  return { type: 'none' }
}

function insertFromSaved(app: App, saved: SavedSelection, text: string) {
  if (!text || text.length === 0) return

  switch (saved.type) {
    case 'editor': {
      if (saved.editor && saved.cursorPos) {
        saved.editor.replaceRange(text, saved.cursorPos, saved.cursorPos)
        saved.editor.setCursor({
          line: saved.cursorPos.line,
          ch: saved.cursorPos.ch + text.length,
        })
      }
      break
    }
    case 'inline-title': {
      // 使用 renameFile API 重命名文件，确保文件名和标题同步更新
      if (saved.file) {
        const newName = text + saved.file.basename + '.' + saved.file.extension
        app.fileManager.renameFile(saved.file, newName)
      }
      break
    }
    case 'rename-input': {
      if (saved.file) {
        // 文件重命名输入框 — 使用 renameFile API
        const basename = saved.file.basename
        const pos = saved.selStart ?? basename.length
        const newName = basename.substring(0, pos) + text + basename.substring(saved.selEnd ?? basename.length)
        app.fileManager.renameFile(saved.file, newName + '.' + saved.file.extension)
      } else if (saved.inputEl) {
        // 普通输入框（非文件重命名），直接修改 DOM
        try {
          saved.inputEl.focus()
          saved.inputEl.setRangeText(text, saved.selStart!, saved.selEnd!, 'end')
          saved.inputEl.dispatchEvent(new Event('input', { bubbles: true }))
          saved.inputEl.dispatchEvent(new Event('change', { bubbles: true }))
        } catch {
          const value = saved.inputEl.value
          saved.inputEl.value =
            value.substring(0, saved.selStart!) + text + value.substring(saved.selEnd!)
          saved.inputEl.dispatchEvent(new Event('input', { bubbles: true }))
        }
      }
      break
    }
    case 'contenteditable': {
      if (saved.contentEl && saved.range) {
        try {
          saved.contentEl.focus()
          const range = saved.range
          range.deleteContents()
          const textNode = document.createTextNode(text)
          range.insertNode(textNode)
          range.setStartAfter(textNode)
          range.collapse(true)
          const sel = window.getSelection()
          if (sel) {
            sel.removeAllRanges()
            sel.addRange(range)
          }
          saved.contentEl.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              inputType: 'insertText',
              data: text,
            }),
          )
        } catch {
          try {
            saved.contentEl.focus()
            document.execCommand('insertText', false, text)
          } catch {
            copyToClipboard(text)
          }
        }
      }
      break
    }
    case 'none': {
      copyToClipboard(text)
      break
    }
  }
}

function copyToClipboard(text: string) {
  try {
    navigator.clipboard.writeText(text)
    new Notice('Emoji 已复制到剪贴板')
  } catch {
    new Notice('无法复制到剪贴板')
  }
}

// ---- EmojiModal ----

class EmojiModal extends Modal {
  private reactComponent: React.ReactElement

  constructor(
    app: App,
    theme: string,
    isNative: boolean,
    onInsert: (emoji: string) => void,
  ) {
    super(app)
    this.reactComponent = React.createElement(EmojiToolbar, {
      onSelect: (emoji: any) => {
        onInsert(emoji.native)
        this.close()
      },
      theme: theme,
      isNative: isNative,
      i18n: EMOJI_I18N,
    })
  }

  onOpen() {
    this.titleEl.empty()
    this.modalEl.id = 'emoji-modal'
    const { contentEl } = this
    try {
      ReactDOM.render(this.reactComponent, contentEl)
    } catch (e) {
      contentEl.createEl('p', { text: `Emoji 选择器加载失败: ${e.message}` })
      console.error('Tutu Emoji Toolbar: render error', e)
    }
  }

  onClose() {
    const { contentEl } = this
    contentEl.empty()
  }
}

// ---- 设置 ----

interface MyPluginSettings {
  twitterEmojiActive: boolean
  hotkey: string
}

const DEFAULT_SETTINGS: MyPluginSettings = {
  twitterEmojiActive: false,
  hotkey: '',
}

// ---- 插件主类 ----

export default class EmojiPickerPlugin extends Plugin {
  settings: MyPluginSettings = Object.assign({}, DEFAULT_SETTINGS)
  private mobileButton: HTMLElement | null = null
  private hotkeyHandler: ((evt: KeyboardEvent) => void) | null = null
  private trackedInput: TrackedInput | null = null
  private focusinHandler: ((evt: FocusEvent) => void) | null = null

  public static postprocessor: MarkdownPostProcessor = (el: HTMLElement) => {
    twemoji.parse(el)
  }

  async onload(): Promise<void> {
    await this.loadSettings()

    // 检测与原版插件的冲突
    if (this.app.plugins.plugins['obsidian-emoji-toolbar']) {
      new Notice('检测到原版 Emoji Toolbar 插件已启用，请先禁用原版插件以避免冲突。', 8000)
    }

    this.addSettingTab(new SettingsTab(this.app, this))

    if (this.settings.twitterEmojiActive) {
      MarkdownPreviewRenderer.registerPostProcessor(EmojiPickerPlugin.postprocessor)
    }

    // 追踪最后聚焦的输入元素
    this.focusinHandler = (evt: FocusEvent) => {
      const target = evt.target as HTMLElement
      if (!target) return

      // 内联标题
      if (target.classList.contains('inline-title') && target.isContentEditable) {
        const file = this.app.workspace.getActiveFile()
        const selection = window.getSelection()
        this.trackedInput = {
          element: target,
          type: 'inline-title',
          file: file ?? undefined,
          range: selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : undefined,
          timestamp: Date.now(),
        }
        return
      }

      // 文件重命名输入框
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (!target.closest('#emoji-modal') && !target.closest('.modal-setting-backdrop')) {
          const fileEl = target.closest('[data-path]')
          let file: TFile | undefined
          if (fileEl) {
            const filePath = fileEl.getAttribute('data-path')
            if (filePath) {
              const f = this.app.vault.getAbstractFileByPath(filePath)
              if (f instanceof TFile) file = f
            }
          }
          this.trackedInput = {
            element: target,
            type: 'rename-input',
            file,
            selStart: target.selectionStart ?? 0,
            selEnd: target.selectionEnd ?? 0,
            timestamp: Date.now(),
          }
        }
        return
      }

      // 其他 contenteditable（排除 CodeMirror 编辑区内容）
      if (
        target.isContentEditable &&
        !target.closest('#emoji-modal') &&
        !target.closest('.cm-content') &&
        !target.classList.contains('inline-title')
      ) {
        const selection = window.getSelection()
        this.trackedInput = {
          element: target,
          type: 'contenteditable',
          range: selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : undefined,
          timestamp: Date.now(),
        }
      }
    }
    document.addEventListener('focusin', this.focusinHandler)

    // Ribbon 图标
    this.addRibbonIcon('smile', '插入 Emoji', () => {
      this.openEmojiPicker()
    })

    // 全局命令
    this.addCommand({
      id: 'emoji-picker:open-picker',
      name: '打开 Emoji 选择器',
      hotkeys: [],
      callback: () => {
        this.openEmojiPicker()
      },
    })

    // 右键上下文菜单
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor) => {
        menu.addItem((item) => {
          item
            .setTitle('插入 Emoji')
            .setIcon('smile')
            .onClick(() => {
              this.openEmojiPicker(editor)
            })
        })
      }),
    )

    // 移动端浮动按钮
    if (Platform.isMobile) {
      this.createMobileButton()
    }

    // 自定义快捷键
    this.registerCustomHotkey()
  }

  onunload() {
    if (this.focusinHandler) {
      document.removeEventListener('focusin', this.focusinHandler)
      this.focusinHandler = null
    }
    if (this.hotkeyHandler) {
      document.removeEventListener('keydown', this.hotkeyHandler)
      this.hotkeyHandler = null
    }
    if (this.mobileButton) {
      this.mobileButton.remove()
      this.mobileButton = null
    }
  }

  openEmojiPicker(editor?: Editor) {
    try {
      const theme = this.app.isDarkMode() ? 'dark' : 'light'
      const isNative = !this.settings.twitterEmojiActive

      let saved: SavedSelection
      if (editor) {
        saved = {
          type: 'editor',
          editor,
          cursorPos: editor.getCursor('from'),
        }
      } else {
        saved = detectInsertTarget(this.app, this.trackedInput)
      }

      const onInsert = (emoji: string) => insertFromSaved(this.app, saved, emoji)
      const myModal = new EmojiModal(this.app, theme, isNative, onInsert)
      myModal.open()
    } catch (e) {
      new Notice(`打开 Emoji 选择器出错: ${e.message}`)
    }
  }

  createMobileButton() {
    this.mobileButton = document.body.createEl('button', {
      cls: 'emoji-toolbar-mobile-btn',
    })
    this.mobileButton.setText('\u{1F60A}')
    this.registerDomEvent(this.mobileButton, 'click', () => {
      this.openEmojiPicker()
    })
  }

  registerCustomHotkey() {
    if (this.hotkeyHandler) {
      document.removeEventListener('keydown', this.hotkeyHandler)
      this.hotkeyHandler = null
    }

    const hotkeyStr = this.settings.hotkey
    if (!hotkeyStr) return

    const parts = hotkeyStr.split('+').map(p => p.trim().toLowerCase())
    const keyLower = parts.pop()
    if (!keyLower) return

    const hasCtrl = parts.includes('ctrl') || parts.includes('control')
    const hasAlt = parts.includes('alt')
    const hasShift = parts.includes('shift')
    const hasMeta = parts.includes('meta') || parts.includes('mod')

    this.hotkeyHandler = (evt: KeyboardEvent) => {
      const target = evt.target as HTMLElement
      const isInInputField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable
      if (isInInputField && !hasCtrl && !hasAlt && !hasMeta) return

      const evtKey = evt.key.length === 1 ? evt.key.toLowerCase() : evt.key
      if (
        evtKey === keyLower &&
        evt.ctrlKey === hasCtrl &&
        evt.altKey === hasAlt &&
        evt.shiftKey === hasShift &&
        evt.metaKey === hasMeta
      ) {
        evt.preventDefault()
        this.openEmojiPicker()
      }
    }

    document.addEventListener('keydown', this.hotkeyHandler)
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }
}

// ---- 设置页 ----

class SettingsTab extends PluginSettingTab {
  plugin: EmojiPickerPlugin

  constructor(app: App, plugin: EmojiPickerPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this

    containerEl.empty()

    containerEl.createEl('h1', { text: 'Tutu Emoji Toolbar' })
    containerEl.createEl('a', { text: 'Forked from oliveryh', href: 'https://github.com/oliveryh/obsidian-emoji-toolbar' })

    containerEl.createEl('h2', { text: '设置' })

    new Setting(containerEl)
      .setName('Twitter Emoji (v16)')
      .setDesc('改进的 Emoji 支持，但可能导致意外行为。')
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.twitterEmojiActive).onChange(async value => {
          this.plugin.settings.twitterEmojiActive = value
          await this.plugin.saveSettings()
          if (value) {
            MarkdownPreviewRenderer.registerPostProcessor(EmojiPickerPlugin.postprocessor)
          } else {
            MarkdownPreviewRenderer.unregisterPostProcessor(EmojiPickerPlugin.postprocessor)
          }
        }),
      )

    new Setting(containerEl)
      .setName('快捷键')
      .setDesc('点击输入框后按下你想设置的快捷键组合，按 Backspace 清除。你也可以在 Obsidian 的「设置 → 快捷键」中配置。')
      .addText(text => {
        text
          .setPlaceholder('例如: Ctrl+Shift+E')
          .setValue(this.plugin.settings.hotkey)

        const inputEl = text.inputEl
        inputEl.readOnly = true
        inputEl.style.cursor = 'pointer'

        inputEl.addEventListener('keydown', (evt: KeyboardEvent) => {
          evt.preventDefault()

          if (evt.key === 'Backspace') {
            inputEl.value = ''
            this.plugin.settings.hotkey = ''
            this.plugin.saveSettings()
            this.plugin.registerCustomHotkey()
            new Notice('快捷键已清除')
            return
          }

          if (evt.key === 'Escape') {
            inputEl.blur()
            return
          }

          if (evt.key === 'Tab') {
            evt.stopImmediatePropagation()
            return
          }

          const parts: string[] = []
          if (evt.ctrlKey) parts.push('Ctrl')
          if (evt.altKey) parts.push('Alt')
          if (evt.shiftKey) parts.push('Shift')
          if (evt.metaKey) parts.push('Meta')

          const key = evt.key
          if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
            parts.push(key.length === 1 ? key.toUpperCase() : key)
            const hotkeyStr = parts.join('+')
            inputEl.value = hotkeyStr
            this.plugin.settings.hotkey = hotkeyStr
            this.plugin.saveSettings()
            this.plugin.registerCustomHotkey()
            new Notice(`快捷键已设置为: ${hotkeyStr}`)
          }
        })

        inputEl.addEventListener('focus', () => {
          inputEl.select()
        })
      })
      .addExtraButton(btn => {
        btn
          .setIcon('cross')
          .setTooltip('清除快捷键')
          .onClick(async () => {
            this.plugin.settings.hotkey = ''
            await this.plugin.saveSettings()
            this.plugin.registerCustomHotkey()
            this.display()
            new Notice('快捷键已清除')
          })
      })
  }
}
