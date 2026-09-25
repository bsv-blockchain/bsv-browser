import { renderHook } from '@testing-library/react-native'
import { useWebViewSource } from '@/hooks/useWebViewSource'

describe('WebView source lifecycle', () => {
  it('resumes the current route on mount and leaves subsequent passive navigation alone', () => {
    const { result, rerender, unmount } = renderHook<string, { command: string; current: string }>(
      ({ command, current }) => useWebViewSource(command, current),
      { initialProps: { command: 'https://reader.example/', current: 'https://reader.example/read/1' } }
    )
    expect(result.current).toBe('https://reader.example/read/1')
    rerender({ command: 'https://reader.example/', current: 'https://reader.example/read/2' })
    expect(result.current).toBe('https://reader.example/read/1')
    unmount()
    const restored = renderHook(() => useWebViewSource('https://reader.example/', 'https://reader.example/read/2'))
    expect(restored.result.current).toBe('https://reader.example/read/2')
  })

  it('honors explicit navigation including a return to the original command URL', () => {
    const { result, rerender } = renderHook<string, { command: string; current: string }>(
      ({ command, current }) => useWebViewSource(command, current),
      { initialProps: { command: 'https://reader.example/', current: 'https://reader.example/read/1' } }
    )
    rerender({ command: 'https://other.example/', current: 'https://other.example/' })
    expect(result.current).toBe('https://other.example/')
    rerender({ command: 'https://reader.example/', current: 'https://reader.example/' })
    expect(result.current).toBe('https://reader.example/')
  })
})
