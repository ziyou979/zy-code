import { useContext } from 'react'
import AppContext from '../components/AppContext.js'

/**
 * `useApp` 是一个 React hook，提供手动退出（卸载）应用的方法。
 */
const useApp = () => useContext(AppContext)
export default useApp
