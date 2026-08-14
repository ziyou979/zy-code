import React, { createContext, useContext, useState, useSyncExternalStore } from 'react'
import { createStore, type Store } from '../state/store.js'
export type VoiceState = {
  voiceState: 'idle' | 'recording' | 'processing'
  voiceError: string | null
  voiceInterimTranscript: string
  voiceAudioLevels: number[]
  voiceWarmingUp: boolean
}
const DEFAULT_STATE: VoiceState = {
  voiceState: 'idle',
  voiceError: null,
  voiceInterimTranscript: '',
  voiceAudioLevels: [],
  voiceWarmingUp: false,
}
type VoiceStore = Store<VoiceState>
const VoiceContext = createContext<VoiceStore | null>(null)
type Props = {
  children: React.ReactNode
}
export function VoiceProvider({ children }: Props) {
  const [store] = useState(() => createStore(DEFAULT_STATE))
  return <VoiceContext.Provider value={store}>{children}</VoiceContext.Provider>
}
function useVoiceStore() {
  const store = useContext(VoiceContext)
  if (!store) {
    throw new Error('useVoiceState must be used within a VoiceProvider')
  }
  return store
}

/**
 * 订阅语音状态的一个切片，仅在所选值发生变化时重新渲染（通过 Object.is 比较）。
 */
export function useVoiceState<T>(selector: (state: VoiceState) => T): T {
  const store = useVoiceStore()
  const get = () => selector(store.getState())
  return useSyncExternalStore(store.subscribe, get, get)
}

/**
 * 获取语音状态 setter。其引用稳定，不会触发重新渲染。
 * store.setState 是同步操作，调用方随后可立即读取 getVoiceState() 获得新值；
 * VoiceKeybindingHandler 依赖这一行为。
 */
export function useSetVoiceState() {
  return useVoiceStore().setState
}

/**
 * 获取用于在回调内同步读取最新状态的函数。它不同于会订阅状态的 useVoiceState，
 * 不会触发重新渲染；适合在事件处理器中读取同一 tick 内先前设置的状态。
 */
export function useGetVoiceState() {
  return useVoiceStore().getState
}
