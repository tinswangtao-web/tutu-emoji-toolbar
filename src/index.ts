import twemoji from '@twemoji/api'
import type {
  App,
  Editor,
  MarkdownPostProcessor,
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
  TFile,
} from 'obsidian'
import React from 'react'
import ReactDOM from 'react-dom'

import EmojiToolbar from './ui/EmojiToolbar'

// emoji-mart 中文国际化（基于 @emoji-mart/data/i18n/zh.json）
import zhI18n from '@emoji-mart/data/i18n/zh.json'
const EMOJI_I18N: unknown = zhI18n

interface EmojiSelection {
  native: string
}

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
    return (itemView as ItemView & { canvas?: { editor?: Editor } }).canvas?.editor
  }
  return undefined
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ObsidianPluginRegistry {
  plugins: Record<string, unknown>
}

function getPluginRegistry(app: App): ObsidianPluginRegistry | undefined {
  return (app as App & { plugins?: ObsidianPluginRegistry }).plugins
}

function getRangeOffsetWithinElement(contentEl: HTMLElement, range?: Range): number | undefined {
  if (!range) return undefined

  try {
    const preRange = range.cloneRange()
    preRange.selectNodeContents(contentEl)
    preRange.setEnd(range.startContainer, range.startOffset)
    return preRange.toString().length
  } catch {
    return undefined
  }
}

function getElementFromNode(node: Node | null): HTMLElement | null {
  if (!node) return null
  return node.instanceOf(HTMLElement) ? node : node.parentElement
}

function getInlineTitleSelection(): { titleEl: HTMLElement; range: Range } | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0).cloneRange()
  const startEl = getElementFromNode(range.startContainer)
  const titleEl = startEl?.closest<HTMLElement>('.inline-title')

  if (!titleEl?.isContentEditable) return null
  return { titleEl, range }
}

function getActiveFileForTitleText(app: App, titleText: string | null | undefined): TFile | undefined {
  const activeFile = app.workspace.getActiveFile()
  if (!activeFile) return undefined

  return titleText?.trim() === activeFile.basename ? activeFile : undefined
}

function buildFilePathWithBasename(file: TFile, basename: string): string {
  const folderPath = file.parent?.path
  const fileName = `${basename}.${file.extension}`
  return folderPath && folderPath !== '/' ? `${folderPath}/${fileName}` : fileName
}

function updateInlineTitleDisplay(app: App, file: TFile, basename: string, preferredEl?: HTMLElement) {
  if (preferredEl?.isConnected) {
    preferredEl.textContent = basename
  }

  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    const view = leaf.view
    if (!(view instanceof MarkdownView) || view.file !== file) continue

    view.containerEl.querySelectorAll<HTMLElement>('.inline-title').forEach(titleEl => {
      titleEl.textContent = basename
    })
  }
}

function getActiveMarkdownEditorForFile(app: App, file: TFile): Editor | undefined {
  const markdownView = app.workspace.getActiveViewOfType(MarkdownView)
  if (markdownView?.file === file) {
    return markdownView.editor
  }

  return undefined
}

function getHeadingRenameTarget(
  app: App,
  editor: Editor,
  cursorPos: { line: number; ch: number },
  text: string,
): { file: TFile; newBasename: string } | undefined {
  const file = app.workspace.getActiveFile()
  if (!file) return undefined

  const lineText = editor.getLine(cursorPos.line)
  const headingMatch = /^(#\s+)(.*)$/.exec(lineText)
  if (!headingMatch) return undefined

  const headingPrefix = headingMatch[1]
  const headingText = headingMatch[2]
  if (headingText.trim() !== file.basename) return undefined

  const headingCursorCh = cursorPos.ch - headingPrefix.length
  if (headingCursorCh < 0) return undefined

  return {
    file,
    newBasename: `${headingText.substring(0, headingCursorCh)}${text}${headingText.substring(headingCursorCh)}`,
  }
}

function syncFirstHeadingWithBasename(app: App, file: TFile, oldBasename: string, newBasename: string) {
  const editor = getActiveMarkdownEditorForFile(app, file)
  if (!editor) return

  const maxLines = Math.min(editor.lineCount(), 80)
  for (let line = 0; line < maxLines; line += 1) {
    const lineText = editor.getLine(line)
    const headingMatch = /^(#\s+)(.*)$/.exec(lineText)
    if (!headingMatch) continue

    const headingText = headingMatch[2]
    if (headingText.trim() === oldBasename) {
      editor.replaceRange(
        `${headingMatch[1]}${newBasename}`,
        { line, ch: 0 },
        { line, ch: lineText.length },
      )
    }
    return
  }
}

function renameFileBasename(
  app: App,
  file: TFile,
  basename: string,
  onSuccess?: (basename: string) => void,
) {
  const trimmedBasename = basename.trim()
  if (!trimmedBasename || trimmedBasename === file.basename) return
  const oldBasename = file.basename

  app.fileManager
    .renameFile(file, buildFilePathWithBasename(file, trimmedBasename))
    .then(() => {
      syncFirstHeadingWithBasename(app, file, oldBasename, trimmedBasename)
      updateInlineTitleDisplay(app, file, trimmedBasename)
      onSuccess?.(trimmedBasename)
    })
    .catch(error => {
      new Notice(`文件重命名失败: ${getErrorMessage(error)}`)
    })
}

function detectInsertTarget(app: App, trackedInput: TrackedInput | null): SavedSelection {
  const activeEl = activeDocument.activeElement?.instanceOf(HTMLElement)
    ? activeDocument.activeElement
    : null
  const inlineTitleSelection = getInlineTitleSelection()

  if (inlineTitleSelection) {
    const file = app.workspace.getActiveFile()
    if (file) {
      return {
        type: 'inline-title',
        file,
        contentEl: inlineTitleSelection.titleEl,
        range: inlineTitleSelection.range,
      }
    }
  }

  // 1. 优先检查当前活跃元素
  if (activeEl) {
    // 内联标题（contenteditable div.inline-title）
    const inlineTitleEl = activeEl.closest<HTMLElement>('.inline-title')
    if (inlineTitleEl?.isContentEditable) {
      const file = app.workspace.getActiveFile()
      if (file) {
        const selection = window.getSelection()
        return {
          type: 'inline-title',
          file,
          contentEl: inlineTitleEl,
          range: selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : undefined,
        }
      }
    }

    // 文件重命名输入框
    if (activeEl.instanceOf(HTMLInputElement) || activeEl.instanceOf(HTMLTextAreaElement)) {
      if (!activeEl.closest('#emoji-modal')) {
        const fileEl = activeEl.closest('[data-path]')
        let titleFile = getActiveFileForTitleText(app, activeEl.value)
        if (fileEl) {
          const filePath = fileEl.getAttribute('data-path')
          if (filePath) {
            const file = app.vault.getAbstractFileByPath(filePath)
            if (file instanceof TFile) {
              titleFile = file
            }
          }
        }
        if (titleFile) {
          return {
            type: 'rename-input',
            file: titleFile,
            inputEl: activeEl,
            selStart: activeEl.selectionStart ?? 0,
            selEnd: activeEl.selectionEnd ?? 0,
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
      !activeEl.closest('.inline-title')
    ) {
      const selection = window.getSelection()
      if (selection && selection.rangeCount > 0) {
        const titleFile = getActiveFileForTitleText(app, activeEl.textContent)
        if (titleFile) {
          return {
            type: 'inline-title',
            file: titleFile,
            contentEl: activeEl,
            range: selection.getRangeAt(0).cloneRange(),
          }
        }

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
        const headingRenameTarget = getHeadingRenameTarget(app, saved.editor, saved.cursorPos, text)
        saved.editor.replaceRange(text, saved.cursorPos, saved.cursorPos)
        saved.editor.setCursor({
          line: saved.cursorPos.line,
          ch: saved.cursorPos.ch + text.length,
        })
        if (headingRenameTarget) {
          renameFileBasename(app, headingRenameTarget.file, headingRenameTarget.newBasename)
        }
      }
      break
    }
    case 'inline-title': {
      // 使用 renameFile API 重命名文件，确保文件名和标题同步更新
      if (saved.file) {
        const file = saved.file
        const titleText = saved.contentEl?.textContent ?? saved.file.basename
        const offset = getRangeOffsetWithinElement(saved.contentEl, saved.range) ?? 0
        const newBasename = `${titleText.substring(0, offset)}${text}${titleText.substring(offset)}`
        renameFileBasename(app, file, newBasename, basename => {
          if (saved.contentEl) updateInlineTitleDisplay(app, file, basename, saved.contentEl)
        })
      }
      break
    }
    case 'rename-input': {
      if (saved.file) {
        // 文件重命名输入框 — 使用 renameFile API
        const basename = saved.inputEl?.value ?? saved.file.basename
        const pos = saved.selStart ?? basename.length
        const end = saved.selEnd ?? basename.length
        const newName = basename.substring(0, pos) + text + basename.substring(end)
        renameFileBasename(app, saved.file, newName)
      } else if (saved.inputEl) {
        // 普通输入框（非文件重命名），直接修改 DOM
        const start = saved.selStart ?? saved.inputEl.selectionStart ?? saved.inputEl.value.length
        const end = saved.selEnd ?? saved.inputEl.selectionEnd ?? start
        try {
          saved.inputEl.focus()
          saved.inputEl.setRangeText(text, start, end, 'end')
          saved.inputEl.dispatchEvent(new Event('input', { bubbles: true }))
          saved.inputEl.dispatchEvent(new Event('change', { bubbles: true }))
        } catch {
          const value = saved.inputEl.value
          saved.inputEl.value = value.substring(0, start) + text + value.substring(end)
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
          const textNode = activeDocument.createTextNode(text)
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
          copyToClipboard(text)
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
    void navigator.clipboard.writeText(text)
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
      onSelect: (emoji: EmojiSelection) => {
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
    } catch (error) {
      contentEl.createEl('p', { text: `Emoji 选择器加载失败: ${getErrorMessage(error)}` })
      console.error('Tutu Emoji Toolbar: render error', error)
    }
  }

  onClose() {
    const { contentEl } = this
    contentEl.empty()
  }
}

// ---- 设置 ----

interface EmojiToolbarSettings {
  twitterEmojiActive: boolean
  hotkey: string
}

const DEFAULT_SETTINGS: EmojiToolbarSettings = {
  twitterEmojiActive: false,
  hotkey: '',
}

// ---- 插件主类 ----

export default class EmojiPickerPlugin extends Plugin {
  settings: EmojiToolbarSettings = Object.assign({}, DEFAULT_SETTINGS)
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
    if (getPluginRegistry(this.app)?.plugins['obsidian-emoji-toolbar']) {
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
      const inlineTitleSelection = getInlineTitleSelection()
      const inlineTitleEl = inlineTitleSelection?.titleEl ?? target.closest<HTMLElement>('.inline-title')
      if (inlineTitleEl?.isContentEditable) {
        const file = this.app.workspace.getActiveFile()
        this.trackedInput = {
          element: inlineTitleEl,
          type: 'inline-title',
          file: file ?? undefined,
          range: inlineTitleSelection?.range,
          timestamp: Date.now(),
        }
        return
      }

      // 文件重命名输入框
      if (target.instanceOf(HTMLInputElement) || target.instanceOf(HTMLTextAreaElement)) {
        if (!target.closest('#emoji-modal') && !target.closest('.modal-setting-backdrop')) {
          const fileEl = target.closest('[data-path]')
          let file = getActiveFileForTitleText(this.app, target.value)
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
        !target.closest('.inline-title')
      ) {
        const selection = window.getSelection()
        const titleFile = getActiveFileForTitleText(this.app, target.textContent)
        this.trackedInput = {
          element: target,
          type: titleFile ? 'inline-title' : 'contenteditable',
          file: titleFile,
          range: selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : undefined,
          timestamp: Date.now(),
        }
      }
    }
    activeDocument.addEventListener('focusin', this.focusinHandler)

    // Ribbon 图标
    this.addRibbonIcon('smile', '插入 Emoji', () => {
      this.openEmojiPicker()
    })

    // 全局命令
    this.addCommand({
      id: 'emoji-picker:open-picker',
      name: '打开 Emoji 选择器',
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
      activeDocument.removeEventListener('focusin', this.focusinHandler)
      this.focusinHandler = null
    }
    if (this.hotkeyHandler) {
      activeDocument.removeEventListener('keydown', this.hotkeyHandler)
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
    } catch (error) {
      new Notice(`打开 Emoji 选择器出错: ${getErrorMessage(error)}`)
    }
  }

  createMobileButton() {
    this.mobileButton = activeDocument.body.createEl('button', {
      cls: 'emoji-toolbar-mobile-btn',
    })
    this.mobileButton.setText('\u{1F60A}')
    this.registerDomEvent(this.mobileButton, 'click', () => {
      this.openEmojiPicker()
    })
  }

  registerCustomHotkey() {
    if (this.hotkeyHandler) {
      activeDocument.removeEventListener('keydown', this.hotkeyHandler)
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
        target.instanceOf(HTMLInputElement) ||
        target.instanceOf(HTMLTextAreaElement) ||
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

    activeDocument.addEventListener('keydown', this.hotkeyHandler)
  }

  async loadSettings() {
    const savedData = (await this.loadData()) as Partial<EmojiToolbarSettings> | null
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedData)
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

    new Setting(containerEl)
      .setName('Tutu Emoji Toolbar')
      .setHeading()

    containerEl.createEl('a', { text: 'Forked from oliveryh', href: 'https://github.com/tinswangtao-web/tutu-emoji-toolbar' })

    new Setting(containerEl)
      .setName('设置')
      .setHeading()

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
        inputEl.addClass('emoji-toolbar-hotkey-input')

        inputEl.addEventListener('keydown', (evt: KeyboardEvent) => {
          evt.preventDefault()

          if (evt.key === 'Backspace') {
            inputEl.value = ''
            this.plugin.settings.hotkey = ''
            void this.plugin.saveSettings()
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
            void this.plugin.saveSettings()
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
