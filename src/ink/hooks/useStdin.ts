import { useContext } from 'react'
import StdinContext from '../components/StdinContext.js'

/**
 * `useStdin` 是一个 React hook，用于提供 stdin stream。
 */
const useStdin = () => useContext(StdinContext)
export default useStdin
