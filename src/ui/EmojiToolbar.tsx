import * as React from 'react'
import twitterData from '@emoji-mart/data/sets/15/twitter.json'
import nativeData from '@emoji-mart/data'
import Picker from '@emoji-mart/react'

const EMOJI_DATA: Record<'native' | 'twitter', unknown> = {
  native: nativeData as unknown,
  twitter: twitterData as unknown,
}

interface EmojiToolbarProps {
  onSelect: (emoji: { native: string }) => void
  theme: string
  isNative: boolean
  i18n: unknown
}

class EmojiToolbar extends React.Component<EmojiToolbarProps> {
  render() {
    return (
      <Picker
        onEmojiSelect={this.props.onSelect}
        autoFocus={true}
        data={this.props.isNative ? EMOJI_DATA.native : EMOJI_DATA.twitter}
        theme={this.props.theme}
        set={this.props.isNative ? 'native' : 'twitter'}
        i18n={this.props.i18n}
      />
    )
  }
}

export default EmojiToolbar
