import React, { Profiler, ReactNode } from 'react'
import { perf } from '@/utils/perf'

/**
 * Wraps a subtree in React's built-in <Profiler> and records each commit's
 * actualDuration as a `commit:<id>` perf span. In production it renders children
 * directly with no Profiler overhead.
 *
 * Usage:
 *   <PerfProfiler id="Browser"><Browser /></PerfProfiler>
 */
export function PerfProfiler({ id, children }: { id: string; children: ReactNode }) {
  if (!__DEV__) return <>{children}</>
  return (
    <Profiler
      id={id}
      onRender={(_id, phase, actualDuration) => {
        perf.measure(`commit:${_id}:${phase}`, actualDuration)
      }}
    >
      {children}
    </Profiler>
  )
}
